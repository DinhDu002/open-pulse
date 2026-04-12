# Knowledge Entry Detail Page with Change History

## Context

Knowledge entries in Open Pulse are extracted by Haiku and stored in `knowledge_entries` table. Active entries are rendered into `.claude/knowledge/*.md` vault files. Currently, entries are displayed as expandable cards in the Knowledge page — there is no dedicated detail page, and no tracking of what changed when an entry is created, edited, or status-toggled.

The user wants a detail page per entry showing full content, actions, and a timeline of all changes with diffs highlighting what was added, removed, or updated.

## Design

### 1. Database — `knowledge_entry_history` table

New table added to `src/db/schema.js`:

```sql
CREATE TABLE IF NOT EXISTS knowledge_entry_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER NOT NULL,
  change_type TEXT NOT NULL,  -- 'created' | 'updated' | 'status_changed'
  snapshot    TEXT NOT NULL,   -- JSON: {title, body, category, status}
  changed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keh_entry ON knowledge_entry_history(entry_id);
```

### 2. Backend — snapshot recording

**File: `src/knowledge/queries.js`**

New function:

```javascript
function insertEntryHistory(db, { entry_id, change_type, snapshot }) {
  db.prepare(`
    INSERT INTO knowledge_entry_history (entry_id, change_type, snapshot, changed_at)
    VALUES (@entry_id, @change_type, @snapshot, @changed_at)
  `).run({
    entry_id,
    change_type,
    snapshot: JSON.stringify(snapshot),
    changed_at: new Date().toISOString(),
  });
}

function getEntryHistory(db, entryId) {
  return db.prepare(`
    SELECT * FROM knowledge_entry_history
    WHERE entry_id = ? ORDER BY changed_at ASC
  `).all(entryId);
}
```

**Snapshot trigger points (in `src/routes/knowledge.js`):**

| Endpoint | change_type | Snapshot content |
|---|---|---|
| `POST /knowledge/scan` (via `upsertKnowledgeEntry`) | `created` | New entry state |
| `PUT /knowledge/entries/:id` | `updated` | State before update |
| `PUT /knowledge/entries/:id/outdated` | `status_changed` | State before toggle |

### 3. API — new endpoint

**File: `src/routes/knowledge.js`**

```
GET /api/knowledge/entries/:id/history
```

Response:
```json
[
  {
    "id": 1,
    "entry_id": 42,
    "change_type": "created",
    "snapshot": {"title": "...", "body": "...", "category": "footgun", "status": "active"},
    "changed_at": "2026-04-11T10:00:00Z"
  },
  ...
]
```

### 4. Frontend — detail page

**File: `public/modules/knowledge.js`**

**Route:** `#knowledge/entries/:id`

**Layout (top to bottom):**

1. **Back link** — `<- Back to entries` returns to list
2. **Header row** — title (large) + category badge + status badge (right-aligned)
3. **Body** — full entry body, pre-wrapped, monospace
4. **Meta row** — source_file (monospace), created_at, updated_at
5. **Actions row** — Edit / Mark Outdated / Delete buttons (same behavior as current card)
6. **Change History section** — timeline of snapshots:
   - Each item shows: timestamp + change_type badge
   - For `created`: show "Entry created" with initial values
   - For `updated` / `status_changed`: show diff against previous snapshot
   - Diff display: green background for added text, red background for removed text (line-level diff)

**Diff algorithm:** Simple line-by-line comparison between consecutive snapshots. Compare `title`, `body`, `category`, `status` fields individually. Use inline color coding:
- Added lines: `background: #00b89420; border-left: 3px solid #00b894`
- Removed lines: `background: #d6303120; border-left: 3px solid #d63031`
- Changed fields (title, category, status): show `old → new`

**Navigation:** Click entry card in list → navigate to `#knowledge/entries/:id`. Card click behavior changes from expand-in-place to navigation.

### 5. Files to modify

| File | Change |
|---|---|
| `src/db/schema.js` | Add `knowledge_entry_history` table + index |
| `src/knowledge/queries.js` | Add `insertEntryHistory()`, `getEntryHistory()`, export them |
| `src/routes/knowledge.js` | Add history endpoint, add snapshot calls to existing PUT routes |
| `src/knowledge/extract.js` | Add snapshot on `upsertKnowledgeEntry` (created) |
| `public/modules/knowledge.js` | Add detail page render, change card click to navigate |

### 6. Verification

1. Restart server, run `npm test` — schema migration should apply cleanly
2. Open `http://127.0.0.1:3827/#knowledge`
3. Edit an entry → verify history snapshot recorded via `curl /api/knowledge/entries/:id/history`
4. Click entry card → verify detail page opens with full info
5. Check change history section shows timeline with diffs
6. Toggle status (active ↔ outdated) → verify status_changed appears in history
7. Playwright screenshot of detail page to verify layout
