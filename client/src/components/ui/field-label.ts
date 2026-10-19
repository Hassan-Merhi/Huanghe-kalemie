import { createContext, useContext } from "react";

/**
 * The id of the label of the Field a control sits in, for the controls a <label for> cannot name (a Select's
 * trigger, an account picker's button): they take it as aria-labelledby, so a screen reader says "Reçu dans".
 */
export const FieldLabelContext = createContext<string | null>(null);

/** aria-labelledby for a control that has no name of its own, from the Field around it. */
export function useFieldLabelledBy(props: { "aria-label"?: string; "aria-labelledby"?: string }): string | undefined {
  const labelId = useContext(FieldLabelContext);
  if (props["aria-labelledby"]) return props["aria-labelledby"];
  return props["aria-label"] ? undefined : labelId ?? undefined;
}
