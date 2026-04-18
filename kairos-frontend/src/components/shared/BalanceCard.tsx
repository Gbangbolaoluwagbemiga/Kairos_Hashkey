import { useWallet } from '@/contexts/WalletContext';
import { cn } from '@/lib/utils';

interface BalanceCardProps {
  compact?: boolean;
}

export function BalanceCard({ compact = false }: BalanceCardProps) {
  const { balance, isConnected } = useWallet();

  if (!isConnected) return null;

  return (
    <div className={cn(
      "flex items-center gap-1.5 px-3 py-1.5 liquid-glass-button text-sm",
      compact ? "text-xs" : ""
    )}>
      <span className="font-medium">{parseFloat(balance || '0').toFixed(4)}</span>
      <span className="text-muted-foreground">BNB</span>
    </div>
  );
}
