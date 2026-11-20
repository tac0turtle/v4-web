import { SubaccountClient } from '@dydxprotocol/v4-client-js';

import { AnalyticsEvents, TransactionMemo } from '@/constants/analytics';
import { timeUnits } from '@/constants/time';
import { WalletNetworkType } from '@/constants/wallets';

import type { RootStore } from '@/state/_store';
import { selectShouldAccountRebalanceUsdc } from '@/state/accountSelectors';
import { appQueryClient } from '@/state/appQueryClient';
import { createAppSelector } from '@/state/appTypes';

import { track } from '@/lib/analytics/analytics';
import { sleep } from '@/lib/timeUtils';

import { createSemaphore, SupersededError } from '../lib/semaphore';
import { logBonsaiError, logBonsaiInfo } from '../logs';
import { BonsaiCore } from '../ontology';
import { createValidatorStoreEffect } from '../rest/lib/indexerQueryStoreEffect';
import {
  selectTxAuthorizedAccount,
  selectTxAuthorizedCloseOnlyAccount,
  selectUserHasUsdcGasForTransaction,
} from '../selectors/accountTransaction';
import { ComplianceStatus } from '../types/summaryTypes';

// Sleep time between rebalances to ensure that the subaccount has time to process the previous transaction
const SLEEP_TIME = timeUnits.second * 10;
const INVALIDATION_SLEEP_TIME = timeUnits.second * 10;

/**
 * @description Lifecycle for rebalancing USDC across chains. This will handle auto-deposits from dYdX Wallet as well as auto-withdrawals to dYdX Wallet.
 */
export function setUpUsdcRebalanceLifecycle(store: RootStore) {
  const balanceAndTransfersSelector = createAppSelector(
    [
      selectTxAuthorizedCloseOnlyAccount,
      selectTxAuthorizedAccount,
      BonsaiCore.compliance.data,
      selectUserHasUsdcGasForTransaction,
      selectShouldAccountRebalanceUsdc,
    ],
    (
      txAuthorizedAccount,
      fullAccessAccount,
      complianceData,
      userHasUsdcGasForTransaction,
      maybeRebalanceAction
    ) => {
      if (!txAuthorizedAccount) {
        return undefined;
      }

      // Close-only (and geo-restricted) accounts may only pull gas funds out of a subaccount;
      // depositing into a subaccount requires full access, same as the manual deposit UI.
      // UNKNOWN means the compliance screen is still loading or failed, so don't deposit yet.
      const canDeposit =
        fullAccessAccount != null && complianceData.status !== ComplianceStatus.UNKNOWN;
      const rebalanceAction =
        maybeRebalanceAction?.requiredAction === 'deposit' && !canDeposit
          ? undefined
          : maybeRebalanceAction;

      const { localDydxWallet, sourceAccount, parentSubaccountInfo } = txAuthorizedAccount;

      return {
        localDydxWallet,
        parentSubaccountInfo,
        sourceAccount,
        userHasUsdcGasForTransaction,
        rebalanceAction,
      };
    }
  );

  const activeRebalance = createSemaphore();

  const noopCleanupEffect = createValidatorStoreEffect(store, {
    selector: balanceAndTransfersSelector,
    handle: (_clientId, compositeClient, data) => {
      if (data == null || !data.userHasUsdcGasForTransaction) {
        return undefined;
      }

      async function rebalanceWalletFunds() {
        // Re-read state: this may run after a previous rebalance, by which time the account's
        // authorization or balances may have changed.
        const current = balanceAndTransfersSelector(store.getState());
        if (current == null || !current.userHasUsdcGasForTransaction) {
          return;
        }
        const { localDydxWallet, parentSubaccountInfo, sourceAccount, rebalanceAction } = current;

        // context: Cosmos wallets do not support our lifecycle methods and are instead handled within useNotificationTypes
        if (rebalanceAction == null || sourceAccount.chain === WalletNetworkType.Cosmos) {
          return;
        }

        if (rebalanceAction.requiredAction === 'deposit') {
          const { amountToDeposit, usdcBalance, targetAmount } = rebalanceAction;

          logBonsaiInfo(
            'usdcRebalanceLifecycle',
            `depositing excess USDC into parent subaccount ${parentSubaccountInfo.subaccount}`,
            {
              subaccountNumber: parentSubaccountInfo.subaccount,
              balance: usdcBalance,
              amountToDeposit,
              targetAmount,
            }
          );

          const subaccountClient = SubaccountClient.forLocalWallet(
            localDydxWallet!,
            parentSubaccountInfo.subaccount
          );

          try {
            track(
              AnalyticsEvents.RebalanceWalletFundsInitiated({
                amountToDeposit,
                subaccountNumber: parentSubaccountInfo.subaccount,
                balance: usdcBalance,
                targetAmount,
                isAutoRebalance: true,
              })
            );

            await compositeClient.depositToSubaccount(
              subaccountClient,
              amountToDeposit,
              TransactionMemo.depositToSubaccount
            );

            track(
              AnalyticsEvents.RebalanceWalletFundsFinalized({
                amountToDeposit,
                subaccountNumber: parentSubaccountInfo.subaccount,
                balance: usdcBalance,
                targetAmount,
                isAutoRebalance: true,
              })
            );
          } catch (error) {
            track(
              AnalyticsEvents.RebalanceWalletFundsError({
                amountToDeposit,
                subaccountNumber: parentSubaccountInfo.subaccount,
                balance: usdcBalance,
                targetAmount,
                error: error.message,
                isAutoRebalance: true,
              })
            );
            throw error;
          } finally {
            await sleep(SLEEP_TIME);

            appQueryClient.invalidateQueries({
              queryKey: ['validator', 'accountBalances'],
              exact: false,
            });

            await sleep(INVALIDATION_SLEEP_TIME);
          }
        }

        if (rebalanceAction.requiredAction === 'withdraw') {
          const { amountToWithdraw, fromSubaccountNumber, usdcBalance, targetAmount } =
            rebalanceAction;

          const subaccountClient = SubaccountClient.forLocalWallet(
            localDydxWallet!,
            fromSubaccountNumber
          );

          logBonsaiInfo(
            'usdcRebalanceLifecycle',
            `withdrawing funds from subaccount (${fromSubaccountNumber}) for gas reserve`,
            {
              balance: usdcBalance,
              amountToWithdraw,
              targetAmount,
              subaccountNumber: fromSubaccountNumber,
            }
          );

          try {
            track(
              AnalyticsEvents.RebalanceWalletFundsInitiated({
                subaccountNumber: parentSubaccountInfo.subaccount,
                balance: usdcBalance,
                amountToWithdraw,
                targetAmount,
                isAutoRebalance: true,
              })
            );
            await compositeClient.withdrawFromSubaccount(
              subaccountClient,
              amountToWithdraw,
              undefined,
              TransactionMemo.withdrawFromSubaccount
            );

            track(
              AnalyticsEvents.RebalanceWalletFundsFinalized({
                subaccountNumber: parentSubaccountInfo.subaccount,
                balance: usdcBalance,
                amountToWithdraw,
                targetAmount,
                isAutoRebalance: true,
              })
            );
          } catch (error) {
            track(
              AnalyticsEvents.RebalanceWalletFundsError({
                amountToWithdraw,
                subaccountNumber: parentSubaccountInfo.subaccount,
                balance: usdcBalance,
                targetAmount,
                error: error.message,
                isAutoRebalance: true,
              })
            );

            throw error;
          } finally {
            await sleep(SLEEP_TIME);

            appQueryClient.invalidateQueries({
              queryKey: ['validator', 'accountBalances'],
              exact: false,
            });

            await sleep(INVALIDATION_SLEEP_TIME);
          }
        }
      }

      activeRebalance
        .run(() => rebalanceWalletFunds())
        .catch((error) => {
          if (error instanceof SupersededError) {
            return;
          }

          logBonsaiError('usdcRebalanceLifecycle', 'error trying to rebalanceWalletFunds', {
            error,
          });
        });

      return undefined;
    },
    handleNoClient: undefined,
  });

  return () => {
    noopCleanupEffect();
    activeRebalance.clear();
  };
}
