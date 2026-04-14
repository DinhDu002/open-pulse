# Remove Daily Reviews Feature — Design Spec

**Date:** 2026-04-14
**Approach:** Full removal (option A) — delete code, drop tables, clean all references

## Goal

Completely remove the daily-reviews feature from Open Pulse. This includes the daily review pipeline, plan generation, cross-project insights, all API endpoints, frontend UI, database tables, config keys, tests, and documentation references.

## Scope

### Files to Delete

| Path | Purpose |
|---|---|
| `src/review/pipeline.js` | Daily review orchestration (context → Opus → save) |
| `src/review/context.js` | Work history + component collection |
| `src/review/queries.js` | daily_reviews + daily_review_insights DB queries |
| `src/review/plan.js` | Plan generation from suggestions |
| `src/review/prompt.md` | Opus prompt template |
| `src/routes/daily-reviews.js` | 14 API endpoints |
| `public/modules/daily-reviews.js` | Frontend UI module (846 lines) |
| `test/review/review.test.js` | Pipeline + query tests |
| `test/routes/plan-routes.test.js` | Plan generation route tests |

### Files to Edit

| File | Change |
|---|---|
| `src/server.js` | Remove daily-reviews route import + registration |
| `src/routes/projects.js` | Remove 2 project-scoped endpoints (`/api/projects/:id/daily-reviews`, `/api/projects/:id/daily-review-insights`) + imports from `review/queries.js` |
| `src/db/schema.js` | Remove `daily_reviews` + `daily_review_insights` table creation, indexes, and migrations (plan columns, projects column) |
| `public/modules/router.js` | Remove `'daily-reviews'` route + `NO_PERIOD` entry |
| `public/index.html` | Remove "Daily Review" nav link |
| `public/modules/projects.js` | Remove daily-reviews/insights fetch + display in project detail |
| `config.json` | Remove 10 keys: `daily_review_enabled`, `daily_review_model`, `daily_review_timeout_ms`, `daily_review_max_suggestions`, `daily_review_history_days`, `plan_generation_enabled`, `plan_generation_model`, `plan_generation_timeout_ms`, `plan_generation_max_context_kb`, `plan_generation_max_concurrent` |
| `test/routes/routes.test.js` | Remove daily-reviews endpoint test blocks |
| `test/db/schema.test.js` | Remove daily_reviews migration tests |
| `test/db/pipeline-runs.test.js` | Remove daily_review pipeline test cases |
| `CLAUDE.md` | Remove all daily-reviews references (architecture diagram, tables, endpoints, config keys, design decisions, tech stack) |

### Database Changes

- **Drop tables:** `daily_reviews`, `daily_review_insights`
- **Drop indexes:** `idx_daily_reviews_date`, `idx_daily_reviews_status`, `idx_dri_date`, `idx_dri_type`, `idx_dri_status`
- **Clean shared table:** Delete rows from `pipeline_runs` where `pipeline IN ('daily_review', 'plan_generation')`
- **Keep:** `pipeline_runs` table (shared with auto-evolves, knowledge extraction)

### Knowledge Entries

- Mark all daily-reviews-related entries in `knowledge_entries` table as outdated
- Vault files in `.claude/knowledge/` will regenerate on next sync cycle

### LaunchD Service

- Check for `~/Library/LaunchAgents/com.open-pulse.daily-review.plist`
- If exists: `launchctl bootout` then delete plist file
- Update `scripts/install.sh` and `scripts/uninstall.sh` if they reference daily-review service

## Out of Scope

- `pipeline_runs` table structure (shared, untouched)
- `callClaude()` helper in `src/knowledge/extract.js` (shared, untouched)
- Auto-evolve feature (independent)
- Knowledge extraction feature (independent)
- Historical design specs in `docs/superpowers/specs/` (kept as archive)

## Verification

1. `npm test` — all tests pass
2. `npm start` — server starts without errors
3. `curl http://127.0.0.1:3827/api/health` — returns healthy
4. `curl http://127.0.0.1:3827/api/daily-reviews` — returns 404
5. Frontend: no "Daily Review" nav link, no broken references
6. `grep -r "daily.review\|daily_review\|dailyReview" src/ public/` — no remaining references (except pipeline_runs cleanup queries if any)
