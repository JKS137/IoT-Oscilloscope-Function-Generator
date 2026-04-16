import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      let isFirestoreError = false;
      let firestoreContext = null;

      try {
        if (this.state.error?.message) {
          firestoreContext = JSON.parse(this.state.error.message);
          if (firestoreContext.operationType) {
            isFirestoreError = true;
          }
        }
      } catch (e) {
         // Not JSON, just regular error
      }

      return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6 text-zinc-100 font-sans">
          <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-8 shadow-2xl space-y-6">
            <div className="flex justify-center">
              <div className="bg-red-500/20 p-4 rounded-full">
                <AlertCircle className="text-red-500" size={48} />
              </div>
            </div>
            
            <div className="text-center space-y-2">
              <h1 className="text-xl font-bold">Something went wrong</h1>
              <p className="text-sm text-zinc-400">
                {isFirestoreError 
                  ? "A database permission error occurred. You may not have access to this resource."
                  : "An unexpected error occurred in the application."}
              </p>
            </div>

            <div className="bg-black/50 rounded-lg p-4 font-mono text-[10px] text-zinc-500 overflow-auto max-h-40">
              {this.state.error?.toString()}
              {isFirestoreError && (
                <div className="mt-2 pt-2 border-t border-zinc-800">
                  <p>Operation: {firestoreContext.operationType}</p>
                  <p>Path: {firestoreContext.path}</p>
                </div>
              )}
            </div>

            <button
              onClick={() => window.location.reload()}
              className="w-full flex items-center justify-center gap-2 bg-zinc-100 text-zinc-950 hover:bg-white transition-colors py-3 rounded-xl font-bold"
            >
              <RefreshCcw size={18} /> Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
