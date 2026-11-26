// Ship styles with the UI module so the host does not need a separate CSS loader.
export const settingsStyles = `
.m365-settings { color: var(--foreground, #202020); font: inherit; display: grid; gap: 24px; max-width: 1100px; width: 100%; min-width: 0; }
.m365-settings * { box-sizing: border-box; min-width: 0; }
.m365-settings h2 { font-size: 20px; font-weight: 600; line-height: 1.4; }
.m365-settings h3 { font-size: 16px; font-weight: 600; line-height: 1.5; }
.m365-settings p { line-height: 1.6; }
.m365-settings .m365-hint { color: var(--muted-foreground, #686868); font-size: 14px; line-height: 1.5; }
.m365-settings .m365-section { display: grid; gap: 18px; padding: 24px; border: 1px solid var(--border, #bbb); border-radius: 12px; }
.m365-settings .m365-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 20px; }
.m365-settings label { display: grid; align-content: start; gap: 8px; font-size: 14px; font-weight: 500; }
.m365-settings input:not([type=checkbox]), .m365-settings textarea, .m365-settings select { display: block; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--muted-foreground, #777); border-radius: 6px; background: var(--background, #fff); color: var(--foreground, #202020); font: inherit; font-size: 16px; }
.m365-settings input::placeholder, .m365-settings textarea::placeholder { color: var(--muted-foreground, #686868); opacity: 1; }
.m365-settings .m365-checkbox { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; font-weight: 400; }
.m365-settings input[type=checkbox] { appearance: auto; width: 18px; height: 18px; flex-shrink: 0; margin-top: 2px; accent-color: var(--primary, #202020); }
.m365-settings button { min-height: 44px; padding: 10px 16px; border: 1px solid var(--border, #aaa); border-radius: 6px; background: var(--muted, #eee); color: var(--foreground, #202020); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; touch-action: manipulation; }
.m365-settings button:hover:not(:disabled) { border-color: var(--foreground, #202020); }
.m365-settings button:disabled { opacity: .5; cursor: not-allowed; }
.m365-settings .m365-primary { background: var(--primary, #202020); color: var(--primary-foreground, #fff); border-color: var(--primary, #202020); }
.m365-settings :is(button,input,textarea,select,a,summary):focus-visible { outline: 3px solid var(--ring, #3279d8); outline-offset: 3px; }
.m365-settings .m365-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.m365-settings details { border-top: 1px solid var(--border, #bbb); padding-top: 18px; }
.m365-settings summary { cursor: pointer; font-size: 14px; font-weight: 500; padding: 8px 0; }
.m365-settings details > :not(summary) { margin-top: 16px; }
.m365-settings dl { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 8px 16px; font-size: 14px; }
.m365-settings dt { color: var(--muted-foreground, #686868); }
.m365-settings dd { margin: 0; overflow-wrap: anywhere; }
.m365-settings [role=alert] { padding: 12px 16px; border: 1px solid var(--destructive, #b82020); border-radius: 6px; }
.m365-settings output { display: block; overflow-wrap: anywhere; }
.m365-settings a { text-decoration: underline; text-underline-offset: 3px; }
.m365-settings table { border-collapse: collapse; width: 100%; font-size: 14px; }
.m365-settings :is(th,td) { border: 1px solid var(--border, #aaa); padding: 12px; text-align: left; vertical-align: top; min-width: 240px; max-width: 360px; overflow-wrap: anywhere; }
.m365-settings th[scope=row], .m365-settings thead th:first-child { min-width: 150px; }
.m365-settings caption { text-align: left; padding: 12px 0; font-weight: 600; }
@media (max-width: 520px) { .m365-settings .m365-section { padding: 16px; } .m365-settings .m365-actions > button { width: 100%; } }
`;
