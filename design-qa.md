# Interview palette QA

final result: passed

## Current revision: interview engine, design frozen · 2026-11-02

- Scope: only the admissions arrow receives a `#00EE77` hover color and a 250ms color transition. Existing scale/opacity behavior remains; no layout, typography, morph, menu, panel or camera design changed.
- Actual current app at 1131×704: morph200×200, camera208×117, controls507×40, arrow base rgb(187,187,187) and computed color transition0.25s. No question-content node exists in ready state; background first-question preparation does not reveal the future question. Console error/warn count=0. `artifacts/interview-engine-ui-check.json`, `interview-engine-updated.jpg`.
- Ready-state geometry was recorded in `interview-engine-ui-check.json`. Before final handoff the same browser tab entered a real interview; the final read-only screenshot is that 1440×900 active view at main question2/5. It is separate from the controlled synthetic test and is not evidence of completed human scoring or camera accuracy. No actions were taken to interrupt that active session. Source CSS/build and actual computed transition were checked for the arrow. Behavioral voice and analysis evidence is recorded separately in `docs/verification.md`.
- All155 automated tests, ESLint, TypeScript and production build passed. Real provider flow23 checks and actual native MP3 playback5 checks passed with explicitly synthetic voice provenance. Real camera accuracy remains unverified: MediaPipe now initializes successfully after the classic-worker loader fix, but device permission did not complete in the verification browser.

## Current revision: visible click and hover stagger · 2026-11-02

- Reproduced the user's report in the actual 3020 app: the CSS module was connected, but its reduced-motion branch produced a 90ms opacity-only transition, no Y movement, and zero item delays. Before evidence: `artifacts/device-motion-before.json`.
- Removed that component-specific override and the matching 90ms retirement path. This menu now follows the user's explicit 550ms motion specification. Other components' motion preferences are unchanged. A painted `entering` stage followed by two animation frames starts transitions reliably, including click mounts; this no longer depends on `@starting-style`.
- Added real mouse pointer-enter/leave handlers around each device group. Hover opens a menu; moving within the group, transparent bridge or child menu retains it; leaving closes it. The first selector click pins a hover-open menu, a second click closes it, and existing outside/Escape handling remains. Touch/pen hover is ignored; tapping still toggles.
- Kept panel typography, colors, width and padding. The panel offset is `calc(100% + 12px)`, so its 16px bridge overlaps the selector on both desktop and mobile. At actual 390×844 with chat open: menu x=17/right=241/bottom=775, settings top=787, gap=12px and bridge=16px.
- Actual 3020 click computed style is now 550ms cubic-bezier(.16,1,.3,1), with 80/160/240/320ms item delays. Intermediate actual app item translates were 2.115px / 5.938px / 12px / 12px, confirming an animation was running instead of only a static final state. After evidence: `artifacts/device-motion-after.json`.
- The isolated fixture bundles the actual DeviceControls and source CSS without hardware or network providers. Native frame sampling records click and synthetic hover transitions from panel opacity=0/Y=10 and row opacity=0/Y=12 to their final values, including the staggered start and end frames. Exit reaches Y≈10 after 523ms and is retired after the exit rather than at 90ms. Synthetic hover→click→leave remains pinned, related-target child-menu crossing stays open, and touch hover opens no menu. Physical mouse travel is not claimed as tested; its bridge geometry and the actual React pointer handlers were checked separately.
- Evidence: `artifacts/device-motion-click-trace.json`, `artifacts/device-motion-hover-trace.json`, `artifacts/device-motion-close-trace.json`, `artifacts/device-motion-interaction-checks.json`, `artifacts/device-motion-mobile-geometry.json`. Final actual screenshots: `artifacts/interview-dropdown-motion-fixed.jpg` (1280×720) and `artifacts/interview-dropdown-motion-mobile.jpg` (390×844).
- All 106 tests, changed-file ESLint, TypeScript and production build passed. No additional findings in independent code review; final browser console error/warn count=0. Rebuilt and restarted only the owned 3020/3021 preview; original 3000/3001 servers were preserved. The fixture server and temporary test tabs were closed; the fresh product tab remains available.

## Current revision: school overview, camera descent and menu motion · 2026-11-02

- Removed the morph start button's native `title`; its accessible name remains. No visible hover instruction or device-readiness checklist remains in the ready card.
- The real status API joins the three root JSON files and provides exactly three lines: 제출 서류 기반 개별 면접 / 면접위원 2명 · 약 12분 / 학업역량 · 잠재역량 · 사회역량 평가. The official 2027 PDF was checked at PDF pages 25 and 46. Preparation, countdown, session snapshot and server expiry all use 720 seconds.
- Actual current app at 1280×720: camera remains x=1055, width=208, height=117. Opening conversation moves its bottom from 627 to 693, equal to the device bar bottom; drawer bottom=560 leaves a 16px gap above the camera. The morph remains 200px and centered independently.
- Actual current app at 390×844: camera remains x=251, width=122, height=68.625; its bottom descends 759→821, equal to settings bottom=821. The settings bar remains inside x=17…247, leaving a 4px gap before the camera. Floating conversation bottom=736.375.
- Preserved the menu's existing colors, dimensions and typography. Normal motion uses 550ms cubic-bezier(.16,1,.3,1), Y=10px panel entry, Y=12px item entry, and 80/160/240/320ms stagger. Item hover scaling/text displacement is removed. Existing click/outside/Escape semantics remain. The verification browser requests reduced motion, so its actual computed duration is the intended 90ms fallback without item stagger; physical pointer hover and normal-speed perception were not exercised.
- [P2, resolved] Mobile settings menus could appear behind the conversation or clip beyond the viewport after the bar moved left. Raised the settings stacking layer to 14 above the conversation's 12 and anchored open mobile/tablet menus to the bar. All three menus measure x=17, width=224 at 390px. Inside click retains the menu; outside click dismisses each. The volume label stays on one line.
- [P2, resolved] At 667×400 the old ready-card height collapsed. The landscape card now measures 233.5×186.969 at (17,62), has no internal overflow (client/scroll height 185), and ends before the morph's left edge x=263.5.
- Evidence: `artifacts/interview-overview-ready.jpg` and `artifacts/interview-overview-floating.jpg` are actual 1280×720 captures; `artifacts/interview-overview-mobile-menu.jpg` is 390×844. Geometry is recorded in `artifacts/interview-overview-layout-checks.json`. Console error/warn entries: 0.
- All 100 tests, ESLint, TypeScript and final production build passed. The latest complete app runs at `http://127.0.0.1:3020/interview`, with realtime on 3021. Existing 3000/3001 processes were preserved; no claim is made that their old backend hot-reloaded. The preview helper is private verification tooling under ignored `artifacts/`.

## Current revision: morph start control and voice pulse · 2026-11-02

- Scope: text-defined interaction changes to the existing app. The previous static start arrow is removed; the morph itself is the native, labelled start control. This revision does not claim a pixel clone of an image reference.
- Actual ready UI: `artifacts/interview-morph-button-ready.jpg`; mobile: `artifacts/interview-morph-button-mobile.jpg`. Desktop wrapper is 200px at 1280×720; mobile wrapper is 140px at 390×844, centered at (195,422). The page has zero `.start-button` elements and an enabled native `[data-morph-start]` button after preparation finishes.
- Idle appearance is grayscale(1), with all eight fluid animations paused. Test-only pointer entry invokes the actual React handler and real CSS: scale grows smoothly to 1.06, grayscale passes through intermediate values, and fluid animations run. Pointer exit restores grayscale/scale and pauses at the last position. Two observations retain exactly 103299ms; re-entry continues at 103348ms rather than zero. These are synthetic pointer-event integration checks, not physical pointer claims.
- The stable outer visualizer preserves its layer DOM on start. Test clicks remove the start control, enter preparing and increment the start counter once. Returning to ready resets hover/focus engagement, restoring gray and paused layers; the disabled native start button cannot activate.
- Interviewer and candidate share the same voice-driven contraction/expansion logic and rotation speed. Green/mint identifies interviewer speech; blue/violet identifies the candidate. Palette opacity crossfades use 1.1s, with the initial gray/color filter using .65s. Silent input settles to scale=1 and pauses the layers. Native geometry in the motion-reduction browser measured a candidate pulse from 0.9868 to 1.0154; normal motion uses the wider bounded envelope. Evidence: `artifacts/morph-start-behavior-checks.json`.
- Device menus remain mounted while folding downward, then unmount. Actual browser observed `data-presence=closing`, `aria-hidden=true`, `foldReduced` and duration=.09s before removal; normal mode uses 240ms. Closing menus are inert, and tested revision tokens protect reopen/switch operations from old timers.
- Typography, panel spacing, camera placement, grayscale surfaces and chat palette are unchanged. No new image assets or product routes are introduced. The smaller morph and absent arrow are the intentional layout changes.
- Tests: 83 passed; ESLint, TypeScript and production build passed. Browser console errors/warnings: none. Current result: passed; no unresolved P0/P1/P2 interaction or visual issues in the checked states.

## Current revision: restrained motion and device menus · 2026-11-02

- Visual target is the existing local app plus the user's requested smaller ratio and scale-only hover interaction. Baseline: `artifacts/interview-fixed-morph-ready.jpg` (1280×720). Matched current capture: `artifacts/interview-refined-1280.jpg` (1280×720). Both are 1× CSS/pixel density with no resizing. Full/focused comparisons: `artifacts/interview-interaction-comparison.jpg`, `artifacts/interview-interaction-comparison-detail.jpg`.
- Morph now measures 240×240px desktop and 160×160px mobile, with no outer scaling. At 1440×900 its center stays (720,450); at 1280×720 it stays (640,316.8). Mobile controls remain inside the 390×844 viewport with bottom=821px. Evidence: `artifacts/interview-refined-ready.jpg`, `artifacts/interview-refined-mobile.jpg`.
- Replaced constant movement with smoothed, audio-driven rate changes: interviewer uses output audio, candidate uses input audio plus VAD when available, silence slows, processing uses a restrained glow. The actual component was bundled into an isolated synthetic-signal fixture with no API, microphone or camera. Native DOM observations show different rates for quiet/interviewer/candidate/processing, while all wrappers remain 240px. The browser has motion reduction enabled, so the long 32/28s loops retain gentle rate differences and no sway. Observations: `artifacts/morph-motion-observations.json`.
- Actual browser checked all three menus: an inside heading click leaves the menu open; clicking the room header closes microphone, speaker and camera menus. Selector foreground/background colors remain unchanged on interaction. Removed every color-changing hover rule and added 1.025–1.06 independent scale with a smooth transition. The background browser does not expose a real pointer-hover state, so physical-hover rendering is a residual interaction test limit; CSS/build checks passed.
- [P1, resolved] Previous question survived early termination. Confirmed ending now hides it immediately, retains finalization inputs until the transcript is saved, and retires old playback/socket/pending-question references. Unit tests cover terminal rendering, late results, explicit silent ending and normal empty-answer retry separately.
- Fidelity surfaces: existing Noto typography, grayscale panels, purple/amber accents, gradients, icon system and layout are preserved. The two fluid layers remain live code. Copy change removes interview-process announcements from generated speech, without changing the grounded question after generation.
- Current visual result: passed. No unresolved P0/P1/P2 visual issues; physical hover and real AirPods capture remain validation limits, not claimed successes.

## Current revision: fixed, smaller morph · 2026-11-02

- Source visual: `C:/Users/MAYUNS~1/AppData/Local/Temp/codex-clipboard-b28958e5-fb3f-4e90-9560-c868950dcf12.png`; the user's written correction requests a smaller constant size rather than reproducing the pictured enlargement.
- [P1, resolved] Ready/active state rules independently selected 310/350px, large-screen and height breakpoints changed the size again, and analyser energy added another 14% scale. Replaced those rules with one inherited size: 280px desktop, 180px mobile. Removed the outer audio scale and the two inner keyframe scale components; rotation, border morphing, gradients and audio brightness still animate.
- Browser checks at 1440 × 900: ready/processing/interviewer/candidate × energy 0/1 all return 280 × 280px, transform=none and center=(720,450). A 1920 × 1080 processing check remains 280 × 280px. The 390 × 844 ready and processing checks both return 180 × 180px, centered at (195,422).
- Actual ready screenshots: `artifacts/interview-fixed-morph-ready.jpg` and `artifacts/interview-fixed-morph-mobile.jpg`. Static production-CSS fixture screenshots: `artifacts/interview-fixed-morph-active.jpg` and `artifacts/interview-fixed-morph-processing.jpg`. The fixture cannot request providers, microphone or camera and does not claim a live voice session.
- Comparison: `artifacts/morph-size-comparison.jpg` (full view) and `artifacts/morph-size-comparison-detail.jpg` (central morph). Source 2880 × 1800 pixels was normalized to the 1440 × 900 CSS target, and the implementation is 1440 × 900 pixels. The source shows first-question preparation with a camera; the fixture shows a later preparation with a drawer and no camera. Those content differences are excluded from geometry comparison.
- Fidelity surfaces: typography, controls, neutral surfaces, conversation gradients and source data are preserved. The live morph retains its two sharp fluid layers and a clear gap before the copy. Only size/scale behavior was intentionally changed. No new bitmap assets are needed for this existing code-native animation.
- No unresolved P0/P1/P2 visual issues in the checked states; current visual result: passed.

## Current revision: simplified ready screen and compact controls

- Reference: `C:/Users/MAYUNS~1/AppData/Local/Temp/codex-clipboard-db29d1a8-03d0-440e-8cfa-ab4c0f9714d7.png`. The user's written request reduces the pictured control sizes and removes the specified ready-screen copy.
- Header now reads `면접 연습실` without the shield. Removed ready footer, introduction, idle phase label, fullscreen hint, manual fullscreen controls, and the conversation-opener caption.
- The accessible start button displays only ArrowRight. Its existing click handler still requests fullscreen before starting the session; resume also retains that request. Live start/fullscreen was not exercised because provider keys are missing and the start button is correctly disabled.
- Actual browser at 1440 × 900: start button is 52 × 44px with no visible text; controls are 507 × 40px, reduced from 52px-tall desktop groups. Morph remains centered at `(720, 450)`. The conversation title is 14px, with zero openers while open.
- Actual browser at 390 × 844: controls are 230 × 34px and fully inside the viewport; start is 44 × 40px. Morph remains centered at `(195, 422)`. No requested deleted copy is present.
- Evidence: `artifacts/interview-compact-ready.jpg`, `artifacts/interview-compact-floating.jpg`, `artifacts/interview-compact-mobile.jpg`.
- TypeScript, ESLint and production build passed. No unresolved P0/P1/P2 visual issues in the requested ready/open states.

## Current revision: centered morph and floating conversation

- New visual reference: `C:/Users/MAYUNS~1/AppData/Local/Temp/codex-clipboard-463a5faf-c390-43af-b807-f55325e08478.png`, a cropped conversation-header reference. The user explicitly requested a smaller title, hidden opener while open, floating layout, and centered morph, so the older docked reference below no longer controls those surfaces.
- Removed the center icon, the ready-card introduction and INTERVIEW ROOM, decorative dot elements, and the conversation-footer sentence.
- Ready-card university/department now use the former headline scale: 29px desktop, 34px large desktop, 22px mobile. The arrow is a real accessible link to the verified official 2027 admissions PDF.
- Actual browser at 1440 × 900: morph center is `(720, 450)` both closed/open, stage width remains 1440px, opener count becomes 0 when open. Floating panel bounds: x=1056, y=80, width=360, height=712; title=16px.
- Actual browser at 1920 × 1080: center remains `(960, 540)` closed/open; stage width=1920px; university/department headline=34px. No browser console errors or warnings.
- Actual browser at 390 × 844: panel bounds x=16, y=62, width=358, height=697; title=15px. Opener count=0 while open. Card ends at y=308 and the morph begins at y=322. The 254px device bar remains fully visible and camera bounds are 122 × 68.625px above it.
- Evidence: `artifacts/interview-centered-floating.jpg`, `artifacts/interview-centered-mobile.jpg`.
- A mobile CSS fallback initially retained tablet card/camera/control sizing. Restored mobile dimensions and recaptured the actual browser to verify the 14px card/morph gap and visible end control.
- These changes preserve the current charcoal/gradient palette and the live media component instances. No API/provider logic or transcription rules were changed.
- Current result: passed; no outstanding P0/P1/P2 visual issues in the requested states.

## Scope and visual truth

- Request: remove the green cast outside the morph; match the supplied charcoal, violet and amber UI; add a complementary gradient to the morph.
- Source: `C:/Users/MAYUNS~1/AppData/Local/Temp/codex-clipboard-b43ad728-812d-49d7-8783-1f978772cada.png`.
- Source and implementation: 1672 × 941 px, 1672 × 941 CSS viewport, 1× density. No density scaling in comparison inputs.
- Implementation: `artifacts/interview-neutral-listening-fixture.jpg`.
- Full comparison: `artifacts/palette-comparison.jpg` (source left, implementation right).
- Focused comparison: `artifacts/palette-comparison-details.jpg` (question card, morph/action, conversation).
- Test state: main question 2/4, candidate answering, drawer open. The isolated loopback fixture renders actual product components and CSS with test content. It has no scripts, API calls or device access. It does not claim a live voice interview occurred.
- Actual product checks: `/interview` ready state and mobile drawer open/close, 390 × 844. Console errors/warnings: none.
- Final 1440 × 900 responsive evidence: `artifacts/interview-neutral-1440-fixture.jpg`; shortcut hint ends at x=682.52, camera begins at x=761, so their vertical overlap does not cause a visual collision.

## Comparison history

1. [P1, resolved] Original surfaces, help text, device controls and conversation inherited a green cast. Replaced with neutral grayscale surfaces. Green is contained in the morph CSS module; the global CSS audit found zero green-dominant hex colors.
2. [P2, resolved] Candidate/interviewer bubbles and action button did not match the reference. Applied violet gradient to candidate bubbles/actions and a restrained amber background/border to interviewer speech. Question content remains charcoal with white text.
3. [P2, resolved] Early morph comparison looked concentric. Offset its two independently animated layers, lowered front-layer opacity, and retained 8s/6s keyframe values. Final image shows separate glossy surfaces with green/mint/cyan/blue shading.
4. [P2, resolved] Initial button and Space hint were centered as one group, shifting the button left of the morph. Centered the 174 × 58 button under the morph; placed the desktop hint beside it.
5. [P2, resolved] At 1440 × 900 the inline hint approached the camera. The hint now stacks below the action at 1100–1550px; mobile also uses a column. Question card, morph, camera and device bar remain visible.

## Required surfaces

- Typography: retained the local Noto Sans KR variable font; active question heading 28px, question text 17px/1.85, conversation 15px, desktop action 16px. Neutral helper text remains readable.
- Spacing/layout: 580px desktop question card, 416px conversation panel, 52px device controls, centered action and responsive camera. Question label moved outside the content inset to follow the source.
- Colors/tokens: charcoal #171717/#202020, gray borders and text; violet actions/candidate bubbles, amber interviewer bubbles; #00EE77 reserved for morph palette with mint/cyan/blue depth.
- Visual quality: morph stays live CSS, responds to real analyser energy and crossfades palettes; the supplied screenshot is not a background image. Standard icons remain library icons. Keeping the required live morph instead of a raster asset follows the explicit product request.
- Copy/content: test question and answer match the reference; production source data, hidden-question timing and transcript behavior are unchanged. Removed the extra answering headline to match the reference's concise state.

## Accepted differences / residual limits

- Existing timer/fullscreen and recovery controls remain functional. Device-off/disabled states reflect actual available hardware rather than the source's mic-on example.
- [P3] Acknowledgement and question remain separate chronological bubbles, matching their separate audio events. The source combines them visually.
- [P3] The library four-point icon and animated silhouette differ slightly from the source at a single instant. The user-requested palette and two-layer live morph take priority.
- Live API/permission validation is outside this visual-only revision and was not claimed.

## Implementation checklist

- [x] Neutral surfaces outside morph.
- [x] Complementary multicolor gradients and two fluid layers.
- [x] Reference action/chat palette and question hierarchy.
- [x] Browser desktop/mobile checks and focused comparisons.
- [x] TypeScript and ESLint checks.
- [x] Final production build passed without compiler warnings.
