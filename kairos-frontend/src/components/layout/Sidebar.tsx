import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, LayoutDashboard, SquarePen, Menu, Wallet, Store, Trash2, Bot, X, Pencil, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatContext } from '@/contexts/ChatContext';
import { useWallet } from '@/contexts/WalletContext';

const ADMIN_ADDRESS = import.meta.env.VITE_ADMIN_ADDRESS || '';

const allBottomNavItems = [
  { icon: LayoutDashboard, label: 'Dashboard',  path: '/dashboard',  adminOnly: false },
  { icon: Wallet,          label: 'Fund Wallet', path: '/deposit',    adminOnly: false },
  { icon: Store,           label: 'Agents',      path: '/providers',  adminOnly: false },
];

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
  isMobileOpen?: boolean;
}

export function Sidebar({ isCollapsed, onToggle, isMobileOpen }: SidebarProps) {
  const location  = useLocation();
  const navigate  = useNavigate();
  const { createNewSession, sessions, currentSessionId, loadSession, deleteSession, renameSession, messages } = useChatContext();
  const { address, isConnected } = useWallet();

  const isAdmin = isConnected && address?.toLowerCase() === ADMIN_ADDRESS.toLowerCase();
  const bottomNavItems = allBottomNavItems.filter(item => !item.adminOnly || isAdmin);
  const showCollapsed = isCollapsed && !isMobileOpen;

  const currentSession  = sessions.find(s => s.id === currentSessionId);
  const isChatEmpty     = !currentSessionId || (currentSession?.title === 'New Chat' && messages.length === 0);

  // Rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleNewChat = async () => {
    if (isChatEmpty && messages.length === 0) { navigate('/'); return; }
    await createNewSession();
    navigate('/');
  };

  const handleLoadSession = (id: string) => { loadSession(id); navigate('/'); };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteSession(id);
  };

  const handleStartRename = (e: React.MouseEvent, session: any) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleCommitRename = async () => {
    if (editingId && editTitle.trim()) {
      await renameSession(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommitRename();
    } else if (e.key === 'Escape') {
      setEditingId(null);
      setEditTitle('');
    }
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-full glass-panel z-50 transition-all duration-300 flex flex-col border-r border-border/30',
        'max-md:-translate-x-full max-md:w-72',
        isMobileOpen && 'max-md:translate-x-0',
        !isMobileOpen && (isCollapsed ? 'md:w-16' : 'md:w-72'),
      )}
    >
      {/* ── Logo / Toggle ───────────────────────────────────────────── */}
      <div className={cn('p-4 flex items-center border-b border-border/20', showCollapsed ? 'justify-center' : 'gap-3')}>
        {/* Brand icon */}
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center flex-shrink-0 shadow-[0_0_20px_hsl(258_85%_65%/0.3)]">
          <Bot className="w-4 h-4 text-white" />
        </div>

        {!showCollapsed && (
          <span className="text-lg font-display font-semibold kairos-gradient flex-1">
            Kairos
          </span>
        )}

        <button
          onClick={onToggle}
          id="sidebar-toggle"
          className={cn(
            'p-1.5 rounded-lg transition-colors text-muted-foreground hover:text-foreground hover:bg-accent',
            showCollapsed && 'absolute right-0 translate-x-full top-4 glass rounded-r-lg shadow-lg'
          )}
        >
          {isMobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
        </button>
      </div>

      {/* ── New Chat ────────────────────────────────────────────────── */}
      <div className={cn('px-3 pt-4 pb-2', showCollapsed && 'px-2')}>
        <button
          onClick={handleNewChat}
          id="new-chat-btn"
          className={cn(
            'w-full flex items-center gap-2.5 text-sm rounded-xl transition-all duration-200',
            'text-muted-foreground hover:text-foreground hover:bg-accent',
            showCollapsed ? 'justify-center w-10 h-10 mx-auto' : 'px-3 py-2.5'
          )}
        >
          <SquarePen className="w-4 h-4 flex-shrink-0" />
          {!showCollapsed && <span className="font-medium">New Chat</span>}
        </button>
      </div>

      {/* ── Recent Sessions ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden min-h-0 px-3">
        {!showCollapsed && sessions.length > 0 && (
          <>
            <p className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-widest mb-2 px-2 pt-2">
              Recent Chats
            </p>
            <div className="space-y-0.5 pb-4">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => editingId !== session.id && handleLoadSession(session.id)}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-xl transition-all duration-150 group text-left cursor-pointer',
                    currentSessionId === session.id
                      ? 'bg-primary/10 text-primary border border-primary/15'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />

                  {editingId === session.id ? (
                    <input
                      ref={editInputRef}
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onBlur={handleCommitRename}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 text-xs bg-transparent border-b border-primary/40 outline-none py-0.5"
                      maxLength={60}
                    />
                  ) : (
                    <span className="flex-1 truncate text-xs">{session.title}</span>
                  )}

                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    {editingId === session.id ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCommitRename(); }}
                        className="p-1 rounded hover:text-primary transition-all"
                        title="Save"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    ) : (
                      <button
                        onClick={(e) => handleStartRename(e, session)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:text-primary transition-all"
                        title="Rename"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDelete(e, session.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:text-destructive transition-all"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Bottom Nav ──────────────────────────────────────────────── */}
      <div className={cn('px-3 pb-4 border-t border-border/20 pt-3', showCollapsed && 'px-2')}>
        {bottomNavItems.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon     = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              title={showCollapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-3 rounded-xl transition-all duration-200 text-sm mb-1',
                showCollapsed ? 'justify-center w-10 h-10 mx-auto' : 'px-3 py-2.5',
                isActive
                  ? 'bg-primary/10 text-primary border border-primary/15 font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!showCollapsed && <span>{item.label}</span>}
            </NavLink>
          );
        })}
      </div>
    </aside>
  );
}
