# Angular 13 → 21 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the `client/` Angular app from 13.0.x to the latest stable (21.2.x), one major at a time, keeping the app fully working at every step.

**Architecture:** Sequential `ng update` migrations on a dedicated branch (`chore/angular-21`), committing after each major version once `build` + `test` + a manual browser smoke test pass. The largest hand-edits are the Material **MDC** migration (v15) and the **M3 theming** rework of `styles.scss` (v18). NgModule structure is kept (no standalone migration).

**Tech Stack:** Angular CLI, Angular Material/CDK, TypeScript, SCSS, Karma/Jasmine. Backend untouched.

---

## Source spec

`docs/superpowers/specs/2026-06-01-frontend-upgrade-and-visual-refresh-design.md` (Phase 1 only; Phase 2 visual refresh gets its own plan after this lands).

## Conventions used in every upgrade task

- All commands run from `client/` unless stated. Host is Windows + PowerShell.
- **Verification gate (every task):** `npm run build` succeeds → `npm test` passes → **you smoke-test in your own browser** at `http://localhost:4200` → only then commit. This honors the `CLAUDE.md` manual-browser-verification rule; the agent must **wait for your explicit approval** before each commit below.
- **Browser smoke checklist** (same every step): sign in (two accounts in two browsers/profiles), see the DM list, open a thread, send a message and confirm the other account receives it live, edit profile + save, sign out. No console errors, no visual breakage.
- If a step's `ng update` prints peer-dependency or schematic prompts, accept the **recommended/default** answers unless this plan says otherwise. Per-step breaking-change reference: https://angular.dev/update-guide (from 13 to 14, 14 to 15, …).
- One major per task. Never chain two majors before verifying.

---

### Task 0: Branch + un-pin the prerelease baseline

**Files:**
- Modify: `client/package.json` (the `~13.0.0-next.0` pins)

- [ ] **Step 1: Create the working branch off `deploy`**

Run (from repo root):
```powershell
git checkout deploy
git pull --ff-only
git checkout -b chore/angular-21
```

- [ ] **Step 2: Un-pin `@angular/*` from the prerelease tag to stable 13**

In `client/package.json`, change every `@angular/*` dependency currently reading `~13.0.0-next.0` to `~13.4.0` (the v13 LTS line). Leave `@angular/cdk` and `@angular/material` at `^13.3.9`. Do **not** touch other deps yet.

- [ ] **Step 3: Clean install on stable 13**

Run:
```powershell
cd client
Remove-Item -Recurse -Force node_modules, package-lock.json -ErrorAction SilentlyContinue
npm install
```
Expected: install completes without ERESOLVE failures.

- [ ] **Step 4: Verify build + test on stable 13**

Run:
```powershell
npm run build
npm test -- --watch=false --browsers=ChromeHeadless
```
Expected: build emits to `dist/`; Karma runs and the existing specs pass.

- [ ] **Step 5: Browser smoke test (start both processes)**

Backend (repo root, separate terminal): `cd backend; .\.venv\Scripts\Activate.ps1; python main.py`
Frontend: `cd client; npm run start`
Then run the **Browser smoke checklist** above. **Wait for user approval.**

- [ ] **Step 6: Commit the stable-13 baseline**

```powershell
git add client/package.json client/package-lock.json
git commit -m "chore(client): un-pin Angular from 13.0.0-next.0 to stable 13.4 baseline"
```

---

### Task 1: Upgrade to Angular 14

**Files:** `client/package.json`, `client/package-lock.json`, possibly `client/src/app/signin/signin.component.ts`, `client/src/app/signup/signup.component.ts`, `client/src/app/profile/profile.component.ts` (typed forms)

- [ ] **Step 1: Update core + CLI to 14**

```powershell
npx ng update @angular/core@14 @angular/cli@14
```
Expected: schematics run; `package.json` now shows `~14.x`. Review the printed migration summary.

- [ ] **Step 2: Update CDK + Material to 14**

```powershell
npx ng update @angular/cdk@14 @angular/material@14
```

- [ ] **Step 3: Fix typed reactive forms breakage (if the build complains)**

Angular 14 introduces typed `FormGroup`/`FormControl`. If `npm run build` (next step) reports type errors in the three form components, the minimal fix is to keep them untyped by importing the `Untyped*` variants. Example for `signin.component.ts` — replace `FormGroup`/`FormControl`/`FormBuilder` usage:

```typescript
import { UntypedFormGroup, UntypedFormBuilder, Validators } from '@angular/forms';

// field type
signInForm!: UntypedFormGroup;

// in constructor, fb is UntypedFormBuilder
this.signInForm = this.fb.group({
  username: ['', Validators.required],
  password: ['', Validators.required],
});
```
Apply the same `Untyped*` swap in `signup.component.ts` and `profile.component.ts` only where the compiler flags a mismatch. (Proper typing is deferred — out of scope for the upgrade.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS. If it fails, the error points at the file/line — apply the `Untyped*` fix from Step 3 there.

- [ ] **Step 5: Test**

Run: `npm test -- --watch=false --browsers=ChromeHeadless`
Expected: PASS.

- [ ] **Step 6: Browser smoke test** — run the checklist. **Wait for user approval.**

- [ ] **Step 7: Commit**

```powershell
git add client/package.json client/package-lock.json client/src
git commit -m "chore(client): upgrade Angular 13 -> 14"
```

---

### Task 2: Upgrade to Angular 15 (Material MDC — highest risk)

**Files:** `client/package.json`, `client/package-lock.json`, `client/src/app/chat/chat.component.scss` (Material internal selectors), possibly templates using `<mat-list-item>`

- [ ] **Step 1: Update core + CLI to 15**

```powershell
npx ng update @angular/core@15 @angular/cli@15
```

- [ ] **Step 2: Update CDK + Material to 15 (MDC migration)**

```powershell
npx ng update @angular/cdk@15 @angular/material@15
```
The schematic migrates components to MDC. When prompted, **accept the new MDC components** (do NOT choose the `legacy-*` path — we want to land on modern Material, and Phase 2 reworks the styles anyway). The schematic adds a backward-compat CSS shim automatically.

- [ ] **Step 3: Re-target broken Material CSS selectors**

MDC changes Material's internal DOM/class names. In `client/src/app/chat/chat.component.scss`, the rules targeting `.mat-list-item` and `.mat-list-item-content` (in `.chat-users-list`) will no longer match. Re-target them to the MDC equivalents:

```scss
.chat-users-list {
  margin-top: 0;
  padding-top: 0;

  .mat-mdc-list-item {
    font-size: 15px;
    text-align: start;
    color: #fff;
    height: 39px !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }

  .mat-mdc-list-item .mdc-list-item__content,
  .mat-mdc-list-item .mat-mdc-list-item-unscoped-content {
    padding: 0;
  }
}
```
Do the same re-targeting for the `.search-results .mat-list-item` rules → `.mat-mdc-list-item`. (Phase 2 will replace these entirely; this is just to keep v15 visually intact.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS (SCSS `@import` of Material may emit deprecation warnings — acceptable for now; `@use` migration happens at the theming task).

- [ ] **Step 5: Test (expect spec selector breakage)**

Run: `npm test -- --watch=false --browsers=ChromeHeadless`
If specs that query Material DOM fail, update those selectors in the relevant `*.spec.ts` to the `mat-mdc-*` equivalents until green. Most default specs only check `should create` and will pass.

- [ ] **Step 6: Browser smoke test** — pay extra attention to the DM list, buttons, form fields, and inputs (MDC restyles them). **Wait for user approval.**

- [ ] **Step 7: Commit**

```powershell
git add client/package.json client/package-lock.json client/src
git commit -m "chore(client): upgrade Angular 14 -> 15 (Material MDC migration)"
```

---

### Task 3: Upgrade to Angular 16

**Files:** `client/package.json`, `client/package-lock.json`

- [ ] **Step 1: Update core + CLI to 16**

```powershell
npx ng update @angular/core@16 @angular/cli@16
```

- [ ] **Step 2: Update CDK + Material to 16**

```powershell
npx ng update @angular/cdk@16 @angular/material@16
```

- [ ] **Step 3: Build** — `npm run build`. Expected: PASS.

- [ ] **Step 4: Test** — `npm test -- --watch=false --browsers=ChromeHeadless`. Expected: PASS.

- [ ] **Step 5: Browser smoke test.** **Wait for user approval.**

- [ ] **Step 6: Commit**

```powershell
git add client/package.json client/package-lock.json client/src
git commit -m "chore(client): upgrade Angular 15 -> 16"
```

---

### Task 4: Upgrade to Angular 17 (new build system)

**Files:** `client/package.json`, `client/package-lock.json`, `client/angular.json` (builder targets), `client/tsconfig*.json`

- [ ] **Step 1: Update core + CLI to 17**

```powershell
npx ng update @angular/core@17 @angular/cli@17
```
The CLI may migrate `angular.json` from `@angular-devkit/build-angular:browser` to the esbuild-based `application` builder. Accept it.

- [ ] **Step 2: Update CDK + Material to 17**

```powershell
npx ng update @angular/cdk@17 @angular/material@17
```

- [ ] **Step 3: Build** — `npm run build`. Expected: PASS, now via esbuild.

- [ ] **Step 4: Verify the dev server + proxy + LAN flags explicitly**

The `start` script is `ng serve --proxy-config src/proxy.conf.json --port 4200 --host 0.0.0.0 --disable-host-check`. The new dev server (Vite) must still honor these.

Run: `npm run start`
Expected: serves on `:4200`; `/api/*` and `/socket.io/*` proxy to `:3000`. If `--disable-host-check` is rejected by the new serve builder, replace it with an `allowedHosts` entry in `proxy`/serve options or remove it if no longer needed for LAN host headers — confirm LAN access still works. Document whatever change you make in `client/package.json`.

- [ ] **Step 5: Test** — `npm test -- --watch=false --browsers=ChromeHeadless`. Expected: PASS.

- [ ] **Step 6: Browser smoke test** — confirm realtime (Socket.IO) still works through the new dev server proxy (send a live message between two accounts). **Wait for user approval.**

- [ ] **Step 7: Commit**

```powershell
git add client/package.json client/package-lock.json client/angular.json client/tsconfig*.json
git commit -m "chore(client): upgrade Angular 16 -> 17 (esbuild build system)"
```

---

### Task 5: Upgrade to Angular 18

**Files:** `client/package.json`, `client/package-lock.json`

- [ ] **Step 1: Update core + CLI to 18**

```powershell
npx ng update @angular/core@18 @angular/cli@18
```

- [ ] **Step 2: Update CDK + Material to 18**

```powershell
npx ng update @angular/cdk@18 @angular/material@18
```
Note: this is the release where the legacy `mat.define-palette`/`mat.define-light-theme` functions are renamed with an `m2-` prefix and M3 theming arrives. The existing `styles.scss` may still compile via the compatibility names but will emit deprecation warnings — the full M3 rework happens in Task 6, not here. Do the minimum to keep it building (if the build hard-fails on the theme functions, prefix them: `mat.define-palette` → `mat.m2-define-palette`, `mat.define-light-theme` → `mat.m2-define-light-theme`).

- [ ] **Step 3: Build** — `npm run build`. Expected: PASS (deprecation warnings OK).

- [ ] **Step 4: Test** — `npm test -- --watch=false --browsers=ChromeHeadless`. Expected: PASS.

- [ ] **Step 5: Browser smoke test.** **Wait for user approval.**

- [ ] **Step 6: Commit**

```powershell
git add client/package.json client/package-lock.json client/src
git commit -m "chore(client): upgrade Angular 17 -> 18"
```

---

### Task 6: Migrate Material theme to M3 (`styles.scss`)

**Files:** `client/src/styles.scss`, possibly a new `client/src/app/ui/styles/_m3-theme.scss`

This is the largest hand-edit. The current `styles.scss` builds a custom `$md-rojin` palette via the (now deprecated) M2 functions and calls `mat.all-component-themes`. Move to the M3 token system so we land on the modern theming that Phase 2 builds on.

- [ ] **Step 1: Generate an M3 palette from the Rojin brand hue**

Run:
```powershell
npx ng generate @angular/material:m3-theme
```
When prompted, provide the brand seed color `#4a154b` (and accept generating secondary/tertiary/neutral). This writes a palette SCSS file (e.g. `_m3-theme.scss` with `$primary-palette` maps). Place/rename it under `client/src/app/ui/styles/_m3-theme.scss`.

- [ ] **Step 2: Rewrite the theme application in `styles.scss`**

Replace the M2 `define-palette`/`define-light-theme`/`all-component-themes` block with the M3 form. Concretely:

```scss
@use '@angular/material' as mat;
@use './app/ui/styles/m3-theme' as rojin;

$rojin-theme: mat.define-theme((
  color: (
    theme-type: light,
    primary: rojin.$primary-palette,
    tertiary: rojin.$tertiary-palette,
  ),
));

html {
  @include mat.all-component-themes($rojin-theme);
  height: 100%;
  min-height: 100vh;
  min-height: 100dvh;
}
```
Keep the existing `@import './app/ui/styles/tokens';` and the `body` rules. Remove the entire old `$md-rojin` map and the three M2 `$rojin-material-*` variables.

- [ ] **Step 3: Build** — `npm run build`. Expected: PASS, no theme-function deprecation warnings.

- [ ] **Step 4: Test** — `npm test -- --watch=false --browsers=ChromeHeadless`. Expected: PASS.

- [ ] **Step 5: Browser smoke test — full visual pass**

Check every Material control's color against the old look: primary buttons, the `warn` Logout button, `accent` Profile button, form fields, list selection. The purple should match the brand. Note any control whose color shifted — acceptable as long as it reads as the Rojin purple and **all text stays AA-readable**. **Wait for user approval.**

- [ ] **Step 6: Commit**

```powershell
git add client/src/styles.scss client/src/app/ui/styles/_m3-theme.scss
git commit -m "refactor(client): migrate Material theme to M3 token system"
```

---

### Task 7: Upgrade to Angular 19

**Files:** `client/package.json`, `client/package-lock.json`

- [ ] **Step 1: Update core + CLI to 19** — `npx ng update @angular/core@19 @angular/cli@19`
- [ ] **Step 2: Update CDK + Material to 19** — `npx ng update @angular/cdk@19 @angular/material@19`
- [ ] **Step 3: Build** — `npm run build`. Expected: PASS.
- [ ] **Step 4: Test** — `npm test -- --watch=false --browsers=ChromeHeadless`. Expected: PASS.
- [ ] **Step 5: Browser smoke test.** **Wait for user approval.**
- [ ] **Step 6: Commit**

```powershell
git add client/package.json client/package-lock.json client/src
git commit -m "chore(client): upgrade Angular 18 -> 19"
```

---

### Task 8: Upgrade to Angular 20

**Files:** `client/package.json`, `client/package-lock.json`

- [ ] **Step 1: Update core + CLI to 20** — `npx ng update @angular/core@20 @angular/cli@20`
- [ ] **Step 2: Update CDK + Material to 20** — `npx ng update @angular/cdk@20 @angular/material@20`
- [ ] **Step 3: Build** — `npm run build`. Expected: PASS.
- [ ] **Step 4: Test** — `npm test -- --watch=false --browsers=ChromeHeadless`. Expected: PASS.
- [ ] **Step 5: Browser smoke test.** **Wait for user approval.**
- [ ] **Step 6: Commit**

```powershell
git add client/package.json client/package-lock.json client/src
git commit -m "chore(client): upgrade Angular 19 -> 20"
```

---

### Task 9: Upgrade to Angular 21 (target)

**Files:** `client/package.json`, `client/package-lock.json`

- [ ] **Step 1: Update core + CLI to 21** — `npx ng update @angular/core@21 @angular/cli@21`
- [ ] **Step 2: Update CDK + Material to 21** — `npx ng update @angular/cdk@21 @angular/material@21`
- [ ] **Step 3: Build** — `npm run build`. Expected: PASS.
- [ ] **Step 4: Test** — `npm test -- --watch=false --browsers=ChromeHeadless`. Expected: PASS.
- [ ] **Step 5: Confirm final versions**

Run:
```powershell
node -e "console.log('core', require('./node_modules/@angular/core/package.json').version); console.log('cli', require('./node_modules/@angular/cli/package.json').version); console.log('material', require('./node_modules/@angular/material/package.json').version)"
```
Expected: all on `21.2.x`.

- [ ] **Step 6: Browser smoke test (full checklist, final).** **Wait for user approval.**

- [ ] **Step 7: Commit**

```powershell
git add client/package.json client/package-lock.json client/src
git commit -m "chore(client): upgrade Angular 20 -> 21"
```

---

### Task 10: Update project docs to reflect Angular 21

**Files:** `CLAUDE.md`, `README.md`

- [ ] **Step 1: Update the CLAUDE.md version note**

In `CLAUDE.md`, replace the "Angular version pinning" paragraph (which says `@angular/*` is pinned to `~13.0.0-next.0` and warns against upgrading) with the current reality:

```markdown
### Angular version
`@angular/*` is on stable **21.2.x**. Material is on the **MDC** components with **M3** token theming (`mat.define-theme` in `styles.scss`, palette in `ui/styles/_m3-theme.scss`). The app still uses **NgModules** (no standalone migration). Upgrade one major at a time via `ng update`.
```

- [ ] **Step 2: Update README prerequisites**

In `README.md`, update the "Prerequisites" note from "Angular 13 works best with Node 14/16" to Node 20+ (Angular 21 requirement).

- [ ] **Step 3: Commit (docs only — no browser gate)**

```powershell
git add CLAUDE.md README.md
git commit -m "docs: reflect Angular 21 + Material M3 in CLAUDE.md and README"
```

---

### Task 11: Integrate the branch

- [ ] **Step 1:** Use the `superpowers:finishing-a-development-branch` skill to decide how to land `chore/angular-21` (merge to `deploy`, open a PR, etc.). Do not merge without that decision and user confirmation.

---

## Self-review notes (author)

- **Spec coverage:** Phase-1 hotspots from the spec are each a task — forms (Task 1), MDC (Task 2), build system (Task 4), M3 theming (Task 6), final target 21.2.x (Task 9), doc updates (Task 10). Phase 2 (visual refresh) is intentionally a separate future plan.
- **Uncertainty acknowledged:** exact per-step schematic output can't be fully predicted; the build+test+browser gate on every task is the safety net, and per-major commits keep rollback to one step.
- **No standalone migration** included — deliberately out of scope per spec.
