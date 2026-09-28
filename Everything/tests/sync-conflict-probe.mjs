// Proves two devices that were offline at the same time cannot destroy each other's work.
//
//   node Everything/tests/sync-conflict-probe.mjs
//
// This is the whole reason the merge exists. The old sync was
// `state.items = data.map(rowToItem)` on load and `state.items[idx] = updated` on every realtime
// push: wholesale last-write-wins, silently. Anything captured offline was simply gone, and two
// people editing one task produced one of them, with no indication which or that a second
// version had ever existed.
//
// The rule every check below defends: a merge may reorder or choose, but it may not destroy.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4419;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });

  // mergeItemLists is pure, so both "devices" can be driven in one page without a backend.
  const merge = (local, remote) => page.evaluate(
    ([l, r]) => {
      const pending = [];
      const out = mergeItemLists(l, r, { onPending: (i) => pending.push(i.id) });
      return { items: out.items, conflicts: out.conflicts, pending };
    },
    [local, remote],
  );

  await check('an item captured offline survives the pull', async () => {
    // The catastrophic case. Captured on the phone with no signal, then synced from desktop.
    const out = await merge(
      [{ id: 'local-1', title: 'Captured on the train', created: 1000, dirty: true }],
      [{ id: 'remote-1', title: 'Something else', created: 2000 }],
    );
    const kept = out.items.find((i) => i.id === 'local-1');
    assert.ok(kept, 'the offline item was discarded by the merge');
    assert.equal(kept.title, 'Captured on the train');
    assert.deepEqual(out.pending, ['local-1'],
      'an item the server never saw must be queued to be pushed, not just kept');
  });

  await check('both devices keep their own new items', async () => {
    const out = await merge(
      [{ id: 'a', title: 'Phone capture', created: 1000, dirty: true }],
      [{ id: 'b', title: 'Laptop capture', created: 2000 }],
    );
    assert.equal(out.items.length, 2, 'one device lost its item');
    assert.deepEqual(out.conflicts, [], 'unrelated items are not a conflict');
  });

  await check('a clean local copy takes the server copy silently', async () => {
    // Normal everyday sync: nothing was edited here, so this must stay quiet.
    const out = await merge(
      [{ id: 'x', title: 'Old text', created: 1000, dirty: false }],
      [{ id: 'x', title: 'New text', created: 1000, updatedAt: 2000 }],
    );
    assert.equal(out.items[0].title, 'New text');
    assert.deepEqual(out.conflicts, [], 'a non-conflicting sync reported a conflict');
  });


  await check('the newer edit wins, and the loser is still kept', async () => {
    const out = await merge(
      [{ id: 'x', title: 'Laptop edit', created: 1000, updatedAt: 5000, dirty: true }],
      [{ id: 'x', title: 'Phone edit', created: 1000, updatedAt: 3000 }],
    );
    assert.equal(out.items[0].title, 'Laptop edit', 'the newer local edit should win');
    assert.equal(out.conflicts.length, 1, 'a divergent edit must be reported');
    assert.equal(out.conflicts[0].kept, 'local');
    // The point of the whole exercise: the losing text still exists somewhere.
    assert.equal(out.conflicts[0].remote.title, 'Phone edit',
      'the losing version was thrown away instead of kept');
  });

  await check('an older local edit does not clobber a newer remote one', async () => {
    const out = await merge(
      [{ id: 'x', title: 'Stale edit', created: 1000, updatedAt: 1000, dirty: true }],
      [{ id: 'x', title: 'Newer edit', created: 1000, updatedAt: 9000 }],
    );
    assert.equal(out.items[0].title, 'Newer edit');
    assert.equal(out.conflicts[0].kept, 'remote');
    assert.equal(out.conflicts[0].local.title, 'Stale edit', 'the local edit was not preserved');
  });

  await check('identical content is never reported as a conflict', async () => {
    // Both sides arrived at the same text independently. Flagging that would train people to
    // ignore the banner, which is how a real conflict gets missed.
    const same = { id: 'x', title: 'Milk', sub: '', created: 1000, updatedAt: 2000 };
    const out = await merge([{ ...same, updatedAt: 9999, dirty: true }], [{ ...same }]);
    assert.deepEqual(out.conflicts, [], 'identical content was flagged as a conflict');
    assert.equal(out.items[0].dirty, false, 'a matching local copy should be settled, not left dirty');
  });


  await check('syncing twice does not report the same conflict twice', async () => {
    const first = await merge(
      [{ id: 'x', title: 'Mine', created: 1000, updatedAt: 5000, dirty: true }],
      [{ id: 'x', title: 'Theirs', created: 1000, updatedAt: 3000 }],
    );
    assert.equal(first.conflicts.length, 1);
    const again = await page.evaluate(([c]) => {
      state.syncConflicts = [];
      recordSyncConflicts(c);
      recordSyncConflicts(c);
      return state.syncConflicts.length;
    }, [first.conflicts]);
    assert.equal(again, 1, 'the same conflict was recorded more than once');
  });

  await check('a conflicting item is not lost when the merge is reversed', async () => {
    // Whichever side wins, the union of the two texts must be recoverable.
    const out = await merge(
      [{ id: 'x', title: 'A version', created: 1000, updatedAt: 1, dirty: true }],
      [{ id: 'x', title: 'B version', created: 1000, updatedAt: 2 }],
    );
    const texts = new Set([out.items[0].title, out.conflicts[0].local.title, out.conflicts[0].remote.title]);
    assert.deepEqual([...texts].sort(), ['A version', 'B version'],
      'one of the two versions disappeared entirely');
  });

  await check('a write that never reached the server is reported, not dropped', async () => {
    // The second silent data loss: a permanently failed push used to be removed from the
    // queue, leaving an item that looked normal and was never on the server.
    const out = await page.evaluate(() => {
      // Seed it the way capture does, so the operation is genuinely in the queue: the update
      // path only patches an operation that is already there, which is what makes this check
      // prove the write is *parked* rather than quietly dropped.
      const queued = replaceStructuredSyncOperation({
        kind: 'item',
        action: 'upsert',
        key: 'item:upsert:none:x1',
        clientId: 'x1',
        item: { id: 'x1', title: 'Never synced' },
        attempts: 9,
      });
      const parked = markStructuredSyncFailed(queued, { status: 500, data: { error: 'boom' } });
      recordUnsyncedItem(parked);
      renderSyncConflictBanner();
      return {
        unsynced: state.unsyncedItems,
        visible: getComputedStyle(document.getElementById('syncConflictCard')).display !== 'none',
        stillQueued: readStructuredSyncQueue().filter((op) => op.parkedAt).length,
      };
    });
    assert.equal(out.unsynced.length, 1, 'the failed write was not recorded');
    assert.equal(out.unsynced[0].title, 'Never synced');
    assert.equal(out.stillQueued, 1, 'the operation was discarded instead of parked');
    assert.equal(out.visible, true, 'the user was never told');
  });

  await check('the conflict card appears in the review view', async () => {
    const r = await page.evaluate(() => ({
      card: !!document.getElementById('syncConflictCard'),
      list: !!document.getElementById('syncConflictList'),
    }));
    assert.equal(r.card, true, 'there is nowhere to show a conflict');
    assert.equal(r.list, true, 'the conflict list is missing');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nSYNC CONFLICT CHECKS FAILED' : `\nALL ${results.length} SYNC CONFLICT CHECKS PASSED`);
