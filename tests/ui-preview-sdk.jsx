import { createContext, useContext } from "react";
export const Fixture = createContext(null);
export function usePluginAction(name) { const fixture = useContext(Fixture); return parameters => fixture.action(name, parameters); }
