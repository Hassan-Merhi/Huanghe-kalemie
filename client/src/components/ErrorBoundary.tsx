import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Shows a readable message instead of a blank page when a screen fails, and lets the user go on. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const fr = (localStorage.getItem("lang") ?? "fr") === "fr";
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h2 className="text-lg font-semibold">{fr ? "Cet écran a rencontré un problème" : "This screen ran into a problem"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {fr ? "Rien n'a été perdu. Rechargez la page pour continuer." : "Nothing was lost. Reload the page to carry on."}
        </p>
        <pre className="mt-4 overflow-x-auto rounded bg-muted p-3 text-left text-xs">{error.message}</pre>
        <Button className="mt-4" onClick={() => window.location.reload()}>{fr ? "Recharger" : "Reload"}</Button>
      </div>
    );
  }
}
