import React from 'react';
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WalletProvider } from "@/contexts/WalletContext";
import { ChatProvider } from "@/contexts/ChatContext";
import Index from "./pages/Index";
import Dashboard from "./pages/Dashboard";
import Deposit from "./pages/Deposit";
import Providers from "./pages/Providers";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Error Boundary to catch and display React crashes instead of blank page
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[Kairos ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          background: '#0a0a1a', color: '#e2e8f0', minHeight: '100vh',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'Inter, system-ui, sans-serif', padding: '2rem'
        }}>
          <div style={{ maxWidth: '600px', textAlign: 'center' }}>
            <h1 style={{ fontSize: '2rem', marginBottom: '1rem', color: '#a78bfa' }}>
              Kairos — Startup Error
            </h1>
            <pre style={{
              background: '#1a1a2e', padding: '1rem', borderRadius: '0.75rem',
              textAlign: 'left', overflow: 'auto', fontSize: '0.85rem',
              border: '1px solid #2a2a4a', color: '#f87171'
            }}>
              {this.state.error?.message}
              {'\n\n'}
              {this.state.error?.stack}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: '1.5rem', padding: '0.75rem 2rem',
                background: '#a78bfa', color: '#0a0a1a', border: 'none',
                borderRadius: '9999px', cursor: 'pointer', fontWeight: 600
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <ChatProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner position="top-right" theme="dark" />
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/deposit" element={<Deposit />} />
                <Route path="/providers" element={<Providers />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </ChatProvider>
      </WalletProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
