/**
 * PanelBoundary - one panel's render error must never blank the whole main window.
 *
 * Live 2026-10-10: a hooks-order bug in the dock's Inspector threw (React #300) right
 * after a mission finished. Nothing above it caught the error, so React unmounted the
 * entire root: the main window went empty while the mission kept running underneath.
 * Every HUD panel now sits in its own boundary. A crash shows one quiet line with
 * RETRY where the owner can see it, and the brain, Mission and Atlas keep working.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  
  name: string;
  children: ReactNode;
}

export class PanelBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[panel] ${this.props.name} crashed (contained):`, error, info.componentStack ?? "");
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-crash" role="alert">
        <span>
          {this.props.name} hit an error and was closed — the rest of Praxis is fine.
        </span>
        <button type="button" onClick={() => this.setState({ error: null })}>
          RETRY
        </button>
      </div>
    );
  }
}
