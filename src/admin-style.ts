export const adminCss = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #172033;
  background: #f5f7fb;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #f5f7fb; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: wait; opacity: .6; }
.admin-shell { min-height: 100vh; }
.admin-header { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; padding: 1.1rem max(1.25rem, calc((100vw - 1440px) / 2)); color: #f8fafc; background: #172033; border-bottom: 1px solid #27344d; }
.admin-identity h1 { margin: 0; font-size: 1.2rem; line-height: 1.3; letter-spacing: -.02em; }
.admin-subtitle { margin: .15rem 0 0; color: #b8c3d6; font-size: .82rem; }
.admin-connection { display: flex; align-items: center; gap: .55rem; }
.admin-token { width: min(20rem, 42vw); padding: .55rem .7rem; color: #eef4ff; background: #202d43; border: 1px solid #3c4d6b; border-radius: .4rem; }
.admin-token::placeholder { color: #aab8cf; }
.admin-main { display: grid; grid-template-columns: 15rem minmax(0, 1fr); max-width: 1440px; min-height: calc(100vh - 74px); margin: 0 auto; }
.admin-nav { padding: 1.3rem .9rem; background: #fff; border-right: 1px solid #dce2ed; }
.admin-nav-group + .admin-nav-group { margin-top: 1.7rem; }
.admin-nav-title { margin: 0 0 .5rem; color: #66738a; font-size: .7rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.admin-nav-resource, .admin-nav-operation { display: block; width: 100%; border: 0; border-radius: .35rem; text-align: left; color: #24324a; background: transparent; }
.admin-nav-resource { padding: .48rem .55rem; font-weight: 650; }
.admin-nav-operation { padding: .36rem .75rem; color: #5a6880; font-size: .9rem; }
.admin-nav-resource:hover, .admin-nav-operation:hover, .admin-nav-resource:focus-visible, .admin-nav-operation:focus-visible { color: #173d7a; background: #eaf1fd; outline: 0; }
.admin-nav-operations { margin: .05rem 0 .45rem; padding-left: .25rem; border-left: 1px solid #dce2ed; }
.admin-content { min-width: 0; padding: 2rem clamp(1.15rem, 4vw, 3.25rem); }
.admin-content h2 { margin: 0 0 1.25rem; font-size: 1.55rem; letter-spacing: -.025em; }
.admin-description { max-width: 65ch; margin: -.5rem 0 1.4rem; color: #59677d; }
.admin-notice { margin: 0 0 1rem; padding: .75rem .9rem; border: 1px solid; border-radius: .42rem; font-size: .92rem; white-space: pre-wrap; }
.admin-notice-loading { color: #304f80; border-color: #b8cbea; background: #edf4ff; }
.admin-notice-success { color: #17643d; border-color: #a9ddbc; background: #edfbf2; }
.admin-notice-error { color: #8c2630; border-color: #e9b8bf; background: #fff1f2; }
.admin-form, .admin-filter-form { max-width: 56rem; padding: 1.2rem; background: #fff; border: 1px solid #dce2ed; border-radius: .65rem; box-shadow: 0 1px 2px #1720330d; }
.admin-filter-form { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem; max-width: none; margin-bottom: 1.25rem; }
.admin-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .85rem; width: 100%; }
.admin-field { display: grid; gap: .34rem; min-width: 0; }
.admin-field-wide { grid-column: 1 / -1; }
.admin-field-label { color: #48566d; font-size: .8rem; font-weight: 650; }
.admin-input, .admin-json { width: 100%; padding: .58rem .65rem; color: #172033; background: #fff; border: 1px solid #b9c5d8; border-radius: .38rem; }
.admin-json { min-height: 7rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85rem; line-height: 1.45; }
.admin-input:focus, .admin-json:focus, .admin-token:focus { border-color: #3973c5; outline: 3px solid #3973c533; }
.admin-optional { display: inline-flex; align-items: center; gap: .3rem; color: #66738a; font-size: .78rem; }
.admin-json-fallback { max-width: 56rem; margin-top: .9rem; color: #536179; font-size: .88rem; }
.admin-json-fallback summary { cursor: pointer; font-weight: 650; }
.admin-json-fallback .admin-json { margin-top: .65rem; }
.admin-optional-toggle { accent-color: #2260b8; }
.admin-fieldset { grid-column: 1 / -1; min-width: 0; padding: .85rem; border: 1px solid #d6deeb; border-radius: .42rem; }
.admin-fieldset legend { padding: 0 .3rem; color: #48566d; font-size: .82rem; font-weight: 650; }
.admin-button { border: 1px solid transparent; border-radius: .4rem; padding: .52rem .8rem; font-weight: 650; font-size: .88rem; transition: background .15s ease, border-color .15s ease; }
.admin-button-primary { margin-top: 1rem; color: #fff; background: #215eb1; }
.admin-button-primary:hover { background: #194c92; }
.admin-button-secondary { color: #eaf1fd; background: #293a56; border-color: #435575; }
.admin-content .admin-button-secondary { color: #314563; background: #fff; border-color: #b9c5d8; }
.admin-content .admin-button-secondary:hover { background: #edf3fb; }
.admin-limit { width: 7rem; }
.admin-operation-result { margin-top: 1rem; max-width: 56rem; }
.admin-list-result { min-width: 0; }
.admin-table { width: 100%; border-spacing: 0; border: 1px solid #dce2ed; border-radius: .6rem; overflow: hidden; background: #fff; box-shadow: 0 1px 2px #1720330d; }
.admin-table th, .admin-table td { padding: .72rem .82rem; border-bottom: 1px solid #e4e9f1; text-align: left; vertical-align: top; }
.admin-table th { color: #536179; background: #f7f9fc; font-size: .75rem; letter-spacing: .04em; text-transform: uppercase; }
.admin-table td { max-width: 25rem; overflow-wrap: anywhere; white-space: pre-wrap; font-size: .9rem; }
.admin-table tr:last-child td { border-bottom: 0; }
.admin-result { max-height: 30rem; overflow: auto; margin: 0; padding: 1rem; color: #d8e5fa; background: #18243a; border-radius: .55rem; font: .82rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.admin-paging { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .85rem; }
@media (max-width: 760px) {
  .admin-header { align-items: stretch; flex-direction: column; }
  .admin-token { width: 100%; }
  .admin-main { display: block; }
  .admin-nav { display: flex; gap: 1rem; overflow-x: auto; padding: .8rem 1rem; border-right: 0; border-bottom: 1px solid #dce2ed; }
  .admin-nav-group { flex: 0 0 auto; min-width: 10rem; }
  .admin-nav-group + .admin-nav-group { margin-top: 0; }
  .admin-content { padding: 1.25rem 1rem; }
  .admin-table { display: block; overflow-x: auto; }
}
`
