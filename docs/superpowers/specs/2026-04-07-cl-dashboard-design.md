# CL Dashboard — Design Spec

## Overview

Add comprehensive Continuous Learning (CL) visibility to the Open Pulse dashboard. A new "Learning" page with master-detail layout provides full instinct management, observation browsing, project comparison, and suggestion history. A summary widget on the Dashboard overview gives quick access to CL health.

## Goals

1. **Monitor CL system** — observer status, sync health, learning activity
2. **Explore and manage instincts** — browse, filter, edit confidence, archive, delete
3. **Measure learning effectiveness** — confidence trends, approve/dismiss rates, per-project comparison
4. **Browse observations** — raw learning journal with filters and linked instincts/sessions

## Architecture

### Navigation

Add "Learning" to nav bar between Expert and Settings:
`Dashboard | Sessions | Inventory | Expert | Learning | Settings`

### Page Layout — Master-Detail

```
┌────────────┬────────────────────────────────────────┐
│  Sidebar   │  Main area                             │
│            │                                        │
│  Instincts │  List view ↔ Detail view               │
│  Observ.   │  (breadcrumb navigation)               │
│  Projects  │                                        │
│  Suggest.  │                                        │
│  History   │                                        │
│            │                                        │
│  ──────    │                                        │
│  Stats     │                                        │
│  (mini)    │                                        │
├────────────┴────────────────────────────────────────┤
│  Footer: last sync timestamp, observer status       │
└─────────────────────────────────────────────────────┘
```

**Sidebar**: 4 nav items + mini stats (total instincts, today's observations, pending suggestions). Footer shows last sync time and observer running/stopped.

**Routing**: `#learning` defaults to Instincts. Sub-routes: `#learning/instincts`, `#learning/instincts/:id`, `#learning/observations`, `#learning/observations/:id`, `#learning/projects`, `#learning/projects/:id`, `#learning/suggestions`.

## Sections

### 1. Instincts

#### List View (`#learning/instincts`)

**Filters**: domain (dropdown), project (dropdown), source (dropdown), confidence range (slider), text search.

**Charts row** (collapsible):
- Confidence distribution (histogram)
- Instincts by domain (bar chart)
- Instincts by source (doughnut chart)

**List**: paginated instinct cards showing:
- Name, domain badge, project scope, confidence bar (color-coded: red < 0.3, yellow 0.3-0.6, green > 0.6), seen count
- One-line description (truncated `instinct` field)
- Archive button per item

#### Detail View (`#learning/instincts/:id`)

**Metadata block**: domain, source, project, confidence (visual bar + number), seen count, first/last seen dates, user_validated flag, dismiss count.

**Actions**: Edit confidence, Archive (set confidence to 0), Delete.

**Content**: rendered markdown body of the instinct file.

**Related observations**: list of observations linked via `instinct_id`, with timestamps, session links, and category badges.

**Related suggestions**: list of suggestions where `instinct_id` matches, showing status badge, type, confidence.

### 2. Observations

#### List View (`#learning/observations`)

**Filters**: project (dropdown), category (dropdown), date range (from/to), text search.

**Activity chart** (collapsible): bar chart showing observations per day.

**List**: paginated observation cards showing:
- Timestamp, category badge, project name
- Session ID (clickable → `#sessions/:id`)
- Observation text (truncated)

#### Detail View (`#learning/observations/:id`)

- Full observation text
- Metadata: timestamp, category, project, session link
- Raw context: collapsible JSON viewer (`raw_context` column)
- Linked instinct: link to instinct detail if `instinct_id` is set

### 3. Projects

#### List View (`#learning/projects`)

**Comparison charts** (collapsible, 4 horizontal bar charts):
- Instincts per project
- Avg confidence per project
- Observations per project
- Approve rate per project (approved / (approved + dismissed))

**Project cards**: name, directory, session count, instinct count, observation count, observer status (green dot = running, gray = stopped), last sync time. Actions: [Sync] (force sync), [View] (drill-down).

#### Drill-down (`#learning/projects/:id`)

**Header**: project name, directory, session count, first seen date, observer status with [View log] and [Sync] buttons.

**Learning timeline**: line chart showing instinct count and avg confidence over time (weekly).

**Instincts section**: top 5 by confidence with "View all →" link (navigates to `#learning/instincts` pre-filtered by project).

**Recent observations**: last 5 with "View all →" link (navigates to `#learning/observations` pre-filtered by project).

**Suggestions summary**: counts by status (approved/dismissed/pending), list of pending items with approve/dismiss actions.

**Observer log**: collapsible, last 20 lines from `/api/instincts/observer`.

### 4. Suggestion History

**Filters**: status (all/pending/approved/dismissed), type (skill/agent/hook/rule), project, date range.

**Summary cards**: pending count, approved count, dismissed count, approve rate percentage.

**List**: paginated suggestions showing:
- Status badge (color-coded), description, type badge, confidence
- Source instinct link
- Timestamps (created, resolved)
- Pending items have [Approve] / [Dismiss] buttons inline

### 5. Dashboard Widget

Added to the Dashboard overview page, below existing content:

**Cards row**: total instincts, observations today, active projects, pending suggestions.

**Mini bar chart**: 7-day learning activity (observations + instinct changes per day).

**Recent list**: 5 most recent items mixing new suggestions and new instincts, each clickable → Learning page. "View all →" link to `#learning`.

## Database Changes

### Migration: add `instinct_id` to `cl_observations`

```sql
ALTER TABLE cl_observations ADD COLUMN instinct_id TEXT;
CREATE INDEX idx_cl_observations_instinct ON cl_observations(instinct_id);
```

This enables precise observation → instinct linking. The CL observer populates this when creating observations that contribute to a specific instinct.

## New API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/observations?project=&category=&from=&to=&instinct_id=&page=&per_page=` | Paginated observation list with filters |
| GET | `/api/observations/:id` | Single observation with raw_context |
| GET | `/api/observations/activity?days=` | Observation count per day for activity chart |
| PUT | `/api/instincts/:id` | Update instinct (confidence, archive) |
| DELETE | `/api/instincts/:id` | Delete instinct from DB and disk |
| GET | `/api/instincts/:id/observations` | Observations linked to an instinct |
| GET | `/api/instincts/:id/suggestions` | Suggestions from an instinct |
| GET | `/api/instincts/stats` | Aggregate stats: by domain, by source, confidence distribution |
| GET | `/api/projects/:id/timeline?weeks=` | Weekly instinct count + avg confidence for project |
| GET | `/api/projects/:id/summary` | Project detail with counts and observer status |
| GET | `/api/learning/activity?days=` | Combined learning activity for dashboard widget |
| GET | `/api/learning/recent?limit=` | Recent instincts + suggestions mixed, for dashboard widget |

## Modified API Endpoints

| Method | Path | Change |
|---|---|---|
| GET | `/api/suggestions` | Add `project` filter parameter |
| GET | `/api/instincts` | Add `domain`, `source`, `project`, `confidence_min`, `confidence_max`, `search`, `page`, `per_page` filters |
| GET | `/api/instincts/projects` | Add approve/dismiss counts and rates per project |

## Frontend Module

New file: `public/modules/learning.js`

Follows existing patterns (ES module, exported `init()` and `destroy()` functions, uses `api.js` for fetch, Chart.js for visualizations).

Internal structure:
- `renderSidebar()` — sidebar nav + mini stats
- `renderInstinctsList()` / `renderInstinctDetail(id)`
- `renderObservationsList()` / `renderObservationDetail(id)`
- `renderProjectsList()` / `renderProjectDetail(id)`
- `renderSuggestionHistory()`
- Sub-route parsing from hash fragments

## Modified Frontend Modules

- `public/index.html` — add "Learning" nav link
- `public/modules/router.js` — add `learning` route with lazy load
- `public/modules/dashboard.js` — add CL summary widget
- `public/modules/expert.js` — keep Suggestions tab as-is (quick access), Expert retains Scanner + Actions + Suggestions

## Error Handling

- API errors: show toast notification, keep previous data visible
- Empty states: show contextual message ("No instincts yet — run the CL observer to start learning")
- Observer not running: show warning banner with instructions

## Design Constraints

- Vanilla JS ES modules (no framework, no build step)
- Chart.js 4 (already loaded via CDN)
- Dark theme consistent with existing pages
- CommonJS backend (require/module.exports)
- Pagination: default 20 per page, max 50
