import * as _ from 'underscore';
import { REP_TOKENS } from './rep-tokens';
import { DimStore } from '../inventory/store/d2-store-factory.service';
import { DimItem } from '../inventory/store/d2-item-factory.service';
import { DimInventoryBucket, BucketsService } from '../destiny2/d2-buckets.service';
import { StoreServiceType } from '../inventory/d2-stores.service';
import { IIntervalService, IQService, IRootScopeService } from 'angular';
import { DestinyAccount } from '../accounts/destiny-account.service';
import { pullFromPostmaster } from '../loadout/postmaster';

/**
 * A service for "farming" items by moving them continuously off a character,
 * so that they don't go to the Postmaster.
 */
export function D2FarmingService(
  $rootScope: IRootScopeService,
  $q: IQService,
  dimItemService,
  D2StoresService: StoreServiceType,
  $interval: IIntervalService,
  toaster,
  $i18next,
  D2BucketsService: BucketsService,
  dimSettingsService
) {
  'ngInject';

  let intervalId;
  let subscription;

  const outOfSpaceWarning = _.throttle((store) => {
    toaster.pop('info',
                $i18next.t('FarmingMode.OutOfRoomTitle'),
                $i18next.t('FarmingMode.OutOfRoom', { character: store.name }));
  }, 60000);

  function getMakeRoomBuckets() {
    return D2BucketsService.getBuckets().then((buckets) => {
      return Object.values(buckets.byHash).filter((b) => b.category === 3 && b.type);
    });
  }

  return {
    active: false,
    store: null,
    itemsMoved: 0,
    movingItems: false,
    makingRoom: false,

    // Move all items on the selected character to the vault.
    async moveItemsToVault(store: DimStore, items: DimItem[], makeRoomBuckets: DimInventoryBucket[]) {
      const reservations = {};
      // reserve one space in the active character
      reservations[store.id] = {};
      makeRoomBuckets.forEach((bucket) => {
        reservations[store.id][bucket.type!] = 1;
      });

      for (const item of items) {
        try {
          // Move a single item. We reevaluate each time in case something changed.
          const vault = D2StoresService.getVault()!;
          const vaultSpaceLeft = vault.spaceLeftForItem(item);
          if (vaultSpaceLeft <= 1) {
            // If we're down to one space, try putting it on other characters
            const otherStores = D2StoresService.getStores().filter((s) => !s.isVault && s.id !== store.id);
            const otherStoresWithSpace = otherStores.filter((store) => store.spaceLeftForItem(item));

            if (otherStoresWithSpace.length) {
              if ($featureFlags.debugMoves) {
                console.log("Farming initiated move:", item.amount, item.name, item.type, 'to', otherStoresWithSpace[0].name, 'from', D2StoresService.getStore(item.owner)!.name);
              }
              await dimItemService.moveTo(item, otherStoresWithSpace[0], false, item.amount, items, reservations);
              continue;
            }
          }
          if ($featureFlags.debugMoves) {
            console.log("Farming initiated move:", item.amount, item.name, item.type, 'to', vault.name, 'from', D2StoresService.getStore(item.owner)!.name);
          }
          await dimItemService.moveTo(item, vault, false, item.amount, items, reservations);
        } catch (e) {
          if (e.code === 'no-space') {
            outOfSpaceWarning(store);
          } else {
            toaster.pop('error', item.name, e.message);
          }
          throw e;
        }
      }

      // Also clear out the postmaster
      // We "mock" the toaster interface here so we don't pop up toasters if we can't move stuff
      try {
        await pullFromPostmaster(store, dimItemService, {
          pop(severity, title, message) {
            console.log(severity, title, message);
          }
        });
      } catch (e) {
        console.warn("Cannot move some items off the postmaster:", e);
      }
    },

    // Ensure that there's one open space in each category that could
    // hold an item, so they don't go to the postmaster.
    makeRoomForItems(store: DimStore) {
      return getMakeRoomBuckets().then((makeRoomBuckets) => {
        // If any category is full, we'll move one aside
        let itemsToMove: DimItem[] = [];
        makeRoomBuckets.forEach((makeRoomBucket) => {
          const items = store.buckets[makeRoomBucket.id];
          if (items.length > 0 && items.length >= makeRoomBucket.capacity) {
            // We'll move the lowest-value item to the vault.
            const itemToMove = _.min(items.filter((i) => !i.equipped && !i.notransfer), (i) => {
              let value = {
                Common: 0,
                Uncommon: 1,
                Rare: 2,
                Legendary: 3,
                Exotic: 4
              }[i.tier];
              // And low-stat
              if (i.primStat) {
                value += i.primStat.value / 1000;
              }
              return value;
            });
            if (!_.isNumber(itemToMove)) {
              itemsToMove.push(itemToMove);
            }
          }
        });

        if (dimSettingsService.farming.moveTokens) {
          itemsToMove = itemsToMove.concat(store.items.filter((i) => REP_TOKENS.has(i.hash)));
        }

        if (itemsToMove.length === 0) {
          return $q.resolve();
        }

        this.makingRoom = true;
        return this.moveItemsToVault(store, itemsToMove, makeRoomBuckets)
          .finally(() => {
            this.makingRoom = false;
          });
      });
    },

    start(account: DestinyAccount, storeId: string) {
      if (!this.active) {
        this.active = true;
        this.itemsMoved = 0;
        this.movingItems = false;
        this.makingRoom = false;

        // Whenever the store is reloaded, run the farming algo
        // That way folks can reload manually too
        subscription = D2StoresService.getStoresStream(account).subscribe((stores) => {
          // prevent some recursion...
          if (this.active && !this.movingItems && !this.makingRoom && stores) {
            const store = stores.find((s) => s.id === storeId);
            this.store = store;
            this.makeRoomForItems(store);
          }
        });

        intervalId = $interval(() => {
          // just start reloading stores more often
          $rootScope.$broadcast('dim-refresh');
        }, 60000);
      }
    },

    stop() {
      if (intervalId) {
        $interval.cancel(intervalId);
      }
      if (subscription) {
        subscription.unsubscribe();
        subscription = null;
      }
      this.active = false;
      this.store = null;
    }
  };
}
