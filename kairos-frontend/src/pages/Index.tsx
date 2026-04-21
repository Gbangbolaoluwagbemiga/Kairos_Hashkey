import { useRef, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { ChatInput } from '@/components/chat/ChatInput';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { useChat } from '@/hooks/useChat';
import { useWallet } from '@/contexts/WalletContext';
import { Zap, Bot, TrendingUp, BarChart3, Newspaper, Coins, ArrowRight, Wallet, Brain, ExternalLink, Activity } from 'lucide-react';

type AgentPrompt = { icon: any; label: string; prompt: string; color: string };

const PRICE_PER_CALL_BNB = Number(import.meta.env.VITE_AGENT_PRICE_BNB || '0.0005') || 0.0005;

const FEATURED_AGENTS = [
  { id: 'oracle', name: 'Price Oracle', desc: 'Live prices, ATH, and market peaks', price: String(PRICE_PER_CALL_BNB), color: '#a78bfa' },
  { id: 'news',   name: 'News Scout',   desc: 'Real-time news & sentiment', price: String(PRICE_PER_CALL_BNB), color: '#60a5fa' },
  { id: 'scout',  name: 'Chain Scout',  desc: 'On-chain analytics & wallet facts', price: String(PRICE_PER_CALL_BNB), color: '#34d399' },
  { id: 'yield',  name: 'Yield Optimizer', desc: 'DeFi APY aggregator',      price: String(PRICE_PER_CALL_BNB), color: '#fbbf24' },
  { id: 'tokenomics', name: 'Tokenomics Analyzer', desc: 'Supply & unlock intelligence', price: String(PRICE_PER_CALL_BNB), color: '#f47272' },
  { id: 'chain-scout', name: 'Chain Scout', desc: 'On-chain analytics for EVM networks', price: String(PRICE_PER_CALL_BNB), color: '#22d3ee' },
  { id: 'perp', name: 'Perp Stats', desc: 'Funding, OI and perp market heat', price: String(PRICE_PER_CALL_BNB), color: '#38bdf8' },
  { id: 'protocol', name: 'Protocol Stats', desc: 'TVL, fees, revenue by protocol', price: String(PRICE_PER_CALL_BNB), color: '#fb7185' },
  { id: 'bridges', name: 'Bridge Monitor', desc: 'Cross-chain bridge flow tracking', price: String(PRICE_PER_CALL_BNB), color: '#c084fc' },
];

const Index = () => {
  const { messages, isTyping, isPaying, sendMessage } = useChat();
  const { isConnected, address } = useWallet();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  const agentPrompts: AgentPrompt[] = useMemo(() => {
    const addr = (address || '').trim();
    const walletLine = addr
      ? `Explain my wallet ${addr} — summarize on-chain facts, risks, and next actions.`
      : `Explain my wallet 0x… — paste an address and summarize on-chain facts, risks, and next actions.`;
    return [
      { icon: Activity, label: 'Chain Pulse', prompt: 'What is the live chain pulse on BNB Chain testnet (chainId 97)? Show the last 5 blocks, tx counts, base fee, and native BNB moving on-chain.', color: '#34d399' },
      { icon: Wallet, label: 'Explain my wallet', prompt: walletLine, color: '#22d3ee' },
      { icon: TrendingUp, label: 'Price Oracle', prompt: 'What is the current price and ATH of BNB?', color: '#a78bfa' },
      { icon: Newspaper, label: 'News Scout', prompt: 'What are the latest major crypto news headlines?', color: '#60a5fa' },
      { icon: BarChart3, label: 'Protocol Stats', prompt: 'What are the top DeFi protocols by TVL right now?', color: '#818cf8' },
      { icon: Coins, label: 'Yield Optimizer', prompt: 'What are the best USDC yield opportunities across DeFi?', color: '#fbbf24' },
      { icon: ArrowRight, label: 'Bridge Monitor', prompt: 'Which bridges have the most liquidity today?', color: '#fb7185' },
      { icon: Zap, label: 'DEX', prompt: 'What are the top DEXs by volume on EVM chains today?', color: '#facc15' },
    ];
  }, [address]);

  useEffect(() => {
    if (location.state?.providerName) {
      toast.success(`Connected to ${location.state.providerName}`);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const isEmpty = messages.length === 0;

  return (
    <Layout>
      <div className="flex-1 flex flex-col min-h-0">
        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto scrollbar-hidden">
          {isEmpty ? (
            <HeroState onSend={sendMessage} isConnected={isConnected} agentPrompts={agentPrompts} />
          ) : (
            <div className="py-8 space-y-6">
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  id={message.id}
                  content={message.content}
                  isUser={message.isUser}
                  timestamp={message.timestamp}
                  imagePreview={message.imagePreview}
                  agentsUsed={message.agentsUsed}
                  txHashes={message.txHashes}
                  a2aPayments={message.a2aPayments}
                  partial={message.partial}
                  ragSources={message.ragSources}
                  onContinue={() => sendMessage('continue')}
                />
              ))}

              {isPaying && (
                <div className="px-4 max-w-3xl mx-auto">
                  <div className="glass-card p-3 flex items-center gap-3">
                    <div className="status-dot-payment flex-shrink-0" />
                    <div className="flex-1">
                      <div className="payment-flow-line" />
                    </div>
                    <span className="text-xs text-muted-foreground">Signing payment...</span>
                  </div>
                </div>
              )}
              {isTyping && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input — fixed at bottom */}
        <div className="sticky bottom-0 z-30 bg-background/80 backdrop-blur-xl pb-4 pt-2 border-t border-border/30">
          <ChatInput onSend={sendMessage} disabled={!isConnected || isTyping || isPaying} />
        </div>
      </div>
    </Layout>
  );
};

/* ─── Hero state (empty chat) ─────────────────────────────────────────── */
function HeroState({
  onSend,
  isConnected,
  agentPrompts,
}: {
  onSend: (msg: string) => void;
  isConnected: boolean;
  agentPrompts: AgentPrompt[];
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-4 py-10 space-y-8 max-w-3xl mx-auto w-full">

      {/* Brand */}
      <div className="text-center space-y-3 animate-fade-in-up">
        <div className="relative mx-auto w-16 h-16 mb-1">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 via-purple-600 to-blue-600 flex items-center justify-center shadow-[0_0_60px_hsl(258_85%_65%/0.4)] animate-glow">
            <Bot className="w-8 h-8 text-white" />
          </div>
          <div className="absolute top-0.5 right-0.5 w-3 h-3 rounded-full bg-yellow-400 shadow-[0_0_8px_hsl(42_92%_58%/0.8)] animate-orbit" />
        </div>
        <div>
          <h1 className="text-4xl md:text-5xl font-display font-semibold leading-tight">
            <span className="kairos-gradient">Kairos</span>
          </h1>
          <p className="mt-2 text-base text-muted-foreground max-w-md mx-auto text-balance">
            Built for the{' '}
            <span className="text-[#7dd3fc] font-medium">Four.meme AI Sprint</span>.
            Every answer includes an auditable{' '}
            <span className="text-[hsl(195_90%_55%)] font-medium">on-chain receipt</span>.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <span className="glass-btn px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="status-dot" />9 agents online
          </span>
          <span className="glass-btn px-3 py-1.5 text-xs font-mono text-emerald-400 border border-emerald-500/20 bg-emerald-500/5">
            {PRICE_PER_CALL_BNB.toFixed(4)} BNB / agent call
          </span>
          <span className="glass-btn px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-yellow-400" />BNB Testnet (97)
          </span>
          <a
            href="https://testnet.bscscan.com/address/0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41"
            target="_blank"
            rel="noopener noreferrer"
            className="glass-btn px-3 py-1.5 text-xs text-[hsl(195_90%_55%)] flex items-center gap-1 hover:brightness-125 transition-all"
          >
            Live on-chain <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>
      </div>

      {/* How it works */}
      <div className="w-full animate-slide-up delay-100">
        <p className="text-xs text-muted-foreground text-center mb-3 uppercase tracking-widest">How it works</p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: Wallet,  step: '01', title: 'Connect wallet', desc: 'Connect your EVM wallet (MetaMask). No subscription, no API key.' },
            { icon: Brain,   step: '02', title: 'Ask anything',   desc: 'The orchestrator routes your query to the best specialist agents.' },
              { icon: Zap,     step: '03', title: 'Receipts on-chain', desc: 'Every agent call produces an on-chain receipt. Agents can pay sub-agents (A2A).' },
          ].map(({ icon: Icon, step, title, desc }) => (
            <div key={step} className="glass-card p-3 flex flex-col gap-2 relative overflow-hidden">
              <div className="absolute top-2 right-2 text-[10px] font-mono text-muted-foreground/30 font-bold">{step}</div>
              <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
                <Icon className="w-4 h-4 text-violet-400" />
              </div>
              <p className="text-xs font-semibold text-foreground">{title}</p>
              <p className="text-[10px] text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* live demo strip */}
      <div className="w-full animate-slide-up delay-150">
        <div className="glass-card border border-emerald-500/20 bg-emerald-500/5 p-3 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-400">Payment Flow</span>
            <span className="text-[9px] text-muted-foreground/50 font-mono">BNB Testnet (97)</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-mono overflow-x-auto scrollbar-hidden">
            <span className="text-violet-300 shrink-0">You</span>
            <ArrowRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            <span className="text-[hsl(195_90%_55%)] shrink-0">Kairos Orchestrator</span>
            <ArrowRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            <span className="text-amber-400 shrink-0">Agent A</span>
            <span className="text-[9px] text-emerald-400 shrink-0 bg-emerald-500/10 px-1 rounded">BNB ✓</span>
            <ArrowRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            <span className="text-sky-400 shrink-0">Agent B</span>
            <span className="text-[9px] text-emerald-400 shrink-0 bg-emerald-500/10 px-1 rounded">A2A ✓</span>
          </div>
        </div>
      </div>

      {/* Quick-start prompts */}
      <div className="w-full animate-slide-up delay-200">
        <p className="text-xs text-muted-foreground text-center mb-3 uppercase tracking-widest">Try an agent</p>
        <div className="grid grid-cols-2 gap-2">
          {agentPrompts.map(({ icon: Icon, label, prompt, color }) => (
            <button
              key={label}
              onClick={() => isConnected && onSend(prompt)}
              disabled={!isConnected}
              className="glass-card glass-shimmer p-3 text-left group disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: `${color}18`, border: `1px solid ${color}30` }}>
                  <Icon className="w-3.5 h-3.5" style={{ color }} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">{label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">{prompt}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {!isConnected && (
        <p className="text-xs text-muted-foreground animate-fade-in delay-400">
          Connect your wallet above to start — agents are waiting
        </p>
      )}
    </div>
  );
}

export default Index;
