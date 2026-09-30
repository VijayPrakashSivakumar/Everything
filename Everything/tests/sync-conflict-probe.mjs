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

let PORT = 4419;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
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

  await check('a person added offline survives the pull', async () => {
    // The same catastrophic case as items, in the collection that hurts most to lose: a
    // contact record carries a phone number, an email and every item linked to it.
    const out = await page.evaluate(() => {
      const pending = [];
      const merged = mergeRecordLists(
        [{ id: 'p1', name: 'Priya', phone: '555-0100', updatedAt: 5000, dirty: true }],
        [{ id: 'p9', name: 'Someone else', updatedAt: 9000 }],
        'person',
        (r) => pending.push(r.id),
      );
      return { kept: merged.items.some((i) => i.id === 'p1'), pending };
    });
    assert.equal(out.kept, true, 'a person added offline was discarded');
    assert.deepEqual(out.pending, ['p1'], 'a person the server never saw must be pushed');
  });

  await check('a goal edited on two devices keeps both versions', async () => {
    const out = await page.evaluate(() => {
      const merged = mergeRecordLists(
        [{ id: 'g1', title: 'Run a marathon', status: 'active', updatedAt: 9000, dirty: true }],
        [{ id: 'g1', title: 'Run a marathon', status: 'completed', updatedAt: 4000 }],
        'goal',
      );
      return merged;
    });
    assert.equal(out.items[0].status, 'active', 'the newer local edit should win');
    assert.equal(out.conflicts.length, 1, 'a divergent goal must be reported');
    assert.equal(out.conflicts[0].remote.status, 'completed',
      'the losing goal version was thrown away instead of kept');
    assert.equal(out.conflicts[0].kind, 'goal', 'the conflict must say which collection it came from');
  });

  await check('a clean project list takes the server copy silently', async () => {
    const out = await page.evaluate(() => mergeRecordLists(
      [{ id: 'j1', name: 'Old name', updatedAt: 1000, dirty: false }],
      [{ id: 'j1', name: 'New name', updatedAt: 2000 }],
      'project',
    ));
    assert.equal(out.items[0].name, 'New name');
    assert.deepEqual(out.conflicts, [], 'an ordinary sync reported a conflict');
  });

  await check('identical record content is not a conflict', async () => {
    // Key order must not decide this: the two sides are assembled by different code paths.
    const out = await page.evaluate(() => mergeRecordLists(
      [{ id: 'p2', name: 'Sam', email: 's@x.com', updatedAt: 9999, dirty: true }],
      [{ id: 'p2', email: 's@x.com', name: 'Sam', updatedAt: 1000 }],
      'person',
    ));
    assert.deepEqual(out.conflicts, [], 'identical content was flagged, so key order is leaking in');
  });

  await check('every structured collection is merged, not replaced', () => {
    // The guards in ui-structure.test.mjs cover this at the source level; this is the behavioural
    // statement of the same rule so a future collection added to the loop is obvious.
    return page.evaluate(() => {
      const out = [];
      for (const kind of ['project', 'goal', 'person']) {
        const merged = mergeRecordLists(
          [{ id: `${kind}-local`, name: 'Local only', updatedAt: 1, dirty: true }],
          [{ id: `${kind}-remote`, name: 'Remote only', updatedAt: 2 }],
          kind,
        );
        out.push(merged.items.length);
      }
      return out;
    }).then((counts) => {
      assert.deepEqual(counts, [2, 2, 2], 'a collection dropped a local-only record');
    });
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
