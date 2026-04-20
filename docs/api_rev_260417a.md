# API revision — EQ registration resolve (req 1-7)

**Purpose:** The mobile app must restore **sensor start time** (and optionally canonical **serial**) when the user reconnects a device that is already registered on the server, matching either **serial number** or **BLE MAC** (same physical unit).

**FE status (ahead of BE):** `SettingsService.resolveEqRegistration` calls the endpoint below and falls back to existing `GET /api/settings/eq-list/{serial}` if resolve is missing or returns empty.

---

## New endpoint

### `GET /api/settings/eq-list/resolve`

**Auth:** Bearer JWT (same as other `/api/settings/*` routes).

**Query parameters (at least one required):**

| Param    | Type   | Description |
|----------|--------|-------------|
| `serial` | string | CGM / equipment serial (trimmed). |
| `bleMac` | string | Normalized BLE address: **case-insensitive**, **colons optional**. FE sends uppercase hex with **no** separators (e.g. `A1B2C3D4E5F6`). BE should accept `AA:BB:...` and normalize. |

**Matching rule:** Return the user’s EQ row if **`serial` equals stored serial** OR **`bleMac` equals stored BLE MAC** (OR semantics). If multiple rows match (should not happen), prefer exact `serial` match, then MAC.

**Suggested response `200` JSON body:**

```json
{
  "matchedBy": "serial",
  "serial": "ABC123",
  "bleMac": "A1B2C3D4E5F6",
  "startAt": "2026-04-10T12:00:00.000Z",
  "remainingMinutes": 12345,
  "_id": "optional-mongo-id"
}
```

- `matchedBy`: `"serial"` | `"bleMac"` — which key matched.
- `startAt`: ISO-8601 UTC — **authoritative sensor session start** for remaining-time calculation on FE.
- `remainingMinutes`: optional; if omitted, FE continues to derive from `startAt` + product validity days.
- `serial`: canonical serial on file; FE may update local `eqsn` if user typed a MAC-only alias or vice versa.
- `bleMac`: stored MAC in the same normalized form as query.

**Errors:**

- `400` — both `serial` and `bleMac` missing or invalid.
- `401` — unauthorized.
- `404` — no row matched (FE will fall back to `GET /api/settings/eq-list/{serial}` when `serial` was provided).

---

## Data migration notes

- Persist **bleMac** on EQ registration / upsert (`POST /api/settings/eq-list`) when the app knows the connected device address, so MAC-only recovery works after reinstall.
- Ensure uniqueness per user: (`serial`) and (`bleMac`) should not point to two different active sessions without a defined policy.

---

*Revision: 2026-04-15 — FE first, BE implement `resolve` + store `bleMac` on eq-list rows.*

**BE 구현:** `src/routes/settings.js` (`GET /api/settings/eq-list/resolve`), `src/models/Eq.js`, 통합 명세·서빙 URL은 [api.md](./api.md) (`/api/docs/api.md`).
