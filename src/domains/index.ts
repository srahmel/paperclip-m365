import { createMailModule } from "./mail/index.js";
import { createCalendarModule } from "./calendar/index.js";
import { createDriveModule } from "./drive/index.js";
export function createDomainModules() { return [createMailModule(), createCalendarModule(), createDriveModule()]; }
export const domainTools = createDomainModules().flatMap(module => module.tools);
