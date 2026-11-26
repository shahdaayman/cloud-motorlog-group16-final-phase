# Motorlog DynamoDB audit and access-pattern notes

Audited 17 November 2026. Motorlog uses seven DynamoDB tables through the AWS SDK against Floci. Every table has string partition key `id`. Owned entities store the verified Cognito `sub` as `ownerId`; clients cannot choose it.

## Operation inventory

| File / function | Table(s) | Method and purpose | Assessment |
| --- | --- | --- | --- |
| `shared/db.js` `get`, `owned`, `ownVehicle` | all | `GetCommand` by `id`; ownership is checked after the strongly targeted read | Efficient. Returning 404 for both absent and foreign records prevents record enumeration. |
| `shared/db.js` `put` | all | `PutCommand`; creates use `attribute_not_exists(id)` | Efficient conditional create; prevents an accidental UUID overwrite. |
| `shared/db.js` `patch` | all | `UpdateCommand` by `id` with `attribute_exists(id)` | Efficient conditional update. Routes perform authorization first. |
| `shared/db.js` `del` | owned entities | `DeleteCommand` by `id` after route ownership check | Efficient. Vehicle deletion first queries child indexes to prevent orphans. |
| `shared/db.js` `query` | indexed tables | `QueryCommand`, paginated, with a 2,500 item safety cap; now supports sort-key ranges, order, projection, page limits and continuation keys | Appropriate. Callers must choose an index matching the supplied keys. |
| `shared/db.js` `scan`, `scanAll` | administrative tables | Bounded/paginated `ScanCommand` | Deliberately retained for cross-partition administration. `scanAll` fails at 2,500 rather than silently returning a false total. |
| vehicle list | Vehicles | `owner-index`, then bounded text search/sort in JavaScript | Owner-keyed and isolated. Search is intentionally in-memory because DynamoDB has no substring index. It may read up to the per-owner cap. |
| maintenance history | Maintenance | `vehicle-date-index`: vehicle equality plus optional date range, descending, limited | Improved: previously read all vehicle maintenance and filtered/sorted in JavaScript. Ownership of the vehicle is verified first and rows are defense-in-depth checked. |
| vehicle delete guard | Maintenance, Fuel, Expenses, Reminders | `vehicle-index` per child table | Efficient existence check in the correct partition, though the helper currently reads children rather than projecting/limiting one record. |
| fuel/expense lists | Fuel, Expenses | `vehicle-date-index`: vehicle equality plus optional date range, descending, limited | Improved: date filtering and ordering now occur in DynamoDB. Expense category remains an in-memory filter; a category GSI is not justified for this small per-vehicle result page. |
| fuel create odometer validation | Fuel | `vehicle-index`, followed by chronological consistency check | Correct but reads the vehicle's fuel history. A later optimization could query only neighboring readings with a composite unique sort key; that would require a data migration. |
| fuel economy | Fuel | `vehicle-index`; full-tank interval aggregation in `calc.js` | Meaningful application aggregation. All readings are required for an all-time result, so a complete keyed partition read is appropriate. |
| vehicle cost report | Fuel, Expenses, Maintenance | three parallel `vehicle-date-index` range queries; sum in `calc.js` | Improved: only requested dates are read. DynamoDB does not provide cross-table joins or `GROUP BY`. |
| reminder list | Reminders, Vehicles | two `owner-index` queries; state combines due date/mileage with current vehicle mileage | Appropriate owner-scoped processing. Mileage due state cannot be represented by the existing date GSI. |
| owner summary / maintenance analytics | five owned tables | parallel `owner-index` queries and real sums/counts in JavaScript | Correct and isolated, capped per table. All-time analytics necessarily read the owner's records. |
| monthly analytics | Fuel, Expenses, Maintenance | three parallel `owner-date-index` range queries | Improved: only the requested 1–12 month window is read before monthly aggregation. |
| scheduled notifications | Reminders | `due-index` with `status = Open AND dueDate <= today`, pages of 100 | Efficient and meaningful. Sentinel date excludes mileage-only reminders from email scheduling by design. User profiles are point-read. |
| queue worker | Reminders, Users | two parallel `GetCommand`s, validation, then conditional-by-existence patches | Targeted and idempotency markers reduce duplicate mail. SQS remains at-least-once. |
| admin user list | Users | one paginated scan page, then Cognito role lookup and page-local search/status filter | Scan is unavoidable with the current `id`-only schema and arbitrary substring search. Pagination is exposed. Filters apply per scan page, so a sparse filter can return a short page. |
| last-admin protection | Users | bounded `scanAll`, then Cognito role resolution | Necessary global invariant, but limited to 2,500 profiles. A transactional singleton/admin counter is the production-scale alternative. |
| admin overview / notifications | multiple tables | parallel bounded full scans and JavaScript global counts | Intentionally administrative and infrequent. Honest exact totals require reading every partition; the endpoint fails beyond its cap. Production scale should maintain counters/rollups. |
| admin audit/activity | Audit | paginated or bounded scan; arbitrary text/date/action filters and chronological sort | Retained because historical audit rows have no common partition/sort attributes. For high volume, backfill a constant bucket plus timestamp GSI before switching queries. |
| audit writers | Audit | conditional `PutCommand` with UUID | Append-only creation. No PartiQL is used anywhere in the project. |

## Schema and migration

Existing hash indexes remain: `owner-index`, `vehicle-index`, and reminders `due-index(status, dueDate)`. The migration adds these non-destructively to Maintenance, Fuel, and Expenses:

- `owner-date-index(ownerId, date)` for user/month analytics.
- `vehicle-date-index(vehicleId, date)` for chronological history and date-bounded vehicle costs.

Run `npm run db:migrate` (or `npm run db:prepare`). The script describes every table, creates missing GSIs one at a time, waits for each to become active, and leaves tables, records, and existing indexes intact. Re-running it is safe. DynamoDB backfills existing items automatically; all relevant existing rows already contain `date`. Validate `UpdateTable` GSI creation on the installed Floci version before the demo. No PostgreSQL, table recreation, or sample data is introduced.

## Presentation-ready meaningful queries

1. “Show this authenticated user's vehicles” uses `owner-index`; it never scans other users.
2. “Show a vehicle's maintenance between two dates, newest first” uses a partition equality and sort-key `BETWEEN` on `vehicle-date-index`.
3. “Calculate this vehicle's ownership cost for a period” runs three parallel date-range queries and accurately sums fuel, maintenance, and miscellaneous expenses.
4. “Build the last N monthly cost chart” uses `owner-date-index` on three tables and groups only the requested window in Node.js.
5. “Find open reminders due today” uses `due-index(status, dueDate)` and paginates 100 at a time for the notification queue.
6. “Calculate fuel consumption” reads one vehicle's keyed fuel partition and applies the full-tank-to-full-tank method, including partial fills.
7. “Show reminder state” combines owner-keyed reminders with owner-keyed vehicles so both calendar and odometer due rules are real.

These are intentionally practical rather than artificially SQL-like: DynamoDB performs key selection and ordering, while cross-table totals and grouping are correctly computed in application code.
