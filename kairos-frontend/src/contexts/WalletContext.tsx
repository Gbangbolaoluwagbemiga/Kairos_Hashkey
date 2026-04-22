import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { toast } from 'sonner';
import { FOURMEME_CHAIN_ID, KAIROS_API_URL } from '@/lib/fourmeme';
import { ethers } from 'ethers';

interface WalletContextType {
  isConnected: boolean;
  address: string | null;
  balance: string;
  /** Connect (eth_requestAccounts). May not show a popup if the site is already authorized. */
  connect: () => Promise<string | null>;
  /** Force MetaMask to re-prompt account selection (wallet_requestPermissions). */
  connectPrompt: () => Promise<string | null>;
  /** Request a signature to prove wallet control (always triggers a popup). */
  signIn: () => Promise<string | null>;
  disconnect: () => void;
  refreshBalance: () => void;
  chainOk: boolean;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string>("0.0000");
  const [chainOk, setChainOk] = useState<boolean>(true);
  const providerRef = useRef<ethers.BrowserProvider | null>(null);

  // Load address from localStorage on mount
  useEffect(() => {
    const savedAddress = localStorage.getItem('kairos_address');
    if (savedAddress) {
      setAddress(savedAddress);
    }
  }, []);

  // Fetch balance from backend
  const failCountRef = useRef(0);
  const refreshBalance = useCallback(async () => {
    if (!address) return;
    try {
      const response = await fetch(`${KAIROS_API_URL}/api/fourmeme/balance/${address}`);
      const data = await response.json();
      if (typeof data?.bnb === 'string') setBalance(data.bnb);
      failCountRef.current = 0; // Reset on success
    } catch (error) {
      failCountRef.current++;
      if (failCountRef.current <= 2) {
        console.warn('[Kairos] Backend unreachable — balance polling paused');
      }
      // Silently fail after first 2 logs to avoid console spam
    }
  }, [address]);

  useEffect(() => {
    if (address) {
      refreshBalance();
      // Poll every 30s instead of 10s to reduce console noise
      const interval = setInterval(refreshBalance, 30000);
      return () => clearInterval(interval);
    }
  }, [address, refreshBalance]);

  const connect = useCallback(async () => {
    try {
      const eth = (window as any).ethereum;
      if (!eth) {
        toast.error('No EVM wallet detected. Please install MetaMask (or a compatible wallet).');
        return null;
      }
      providerRef.current = new ethers.BrowserProvider(eth);

      // Request accounts
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      const userAddress = accounts?.[0];
      if (!userAddress) throw new Error('No account selected');

      // Ensure chain is the Sprint demo testnet
      const hexChainId = await eth.request({ method: 'eth_chainId' });
      const current = Number.parseInt(String(hexChainId), 16);
      if (current !== FOURMEME_CHAIN_ID) {
        setChainOk(false);
        try {
          await eth.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${FOURMEME_CHAIN_ID.toString(16)}` }],
          });
          setChainOk(true);
        } catch {
          toast.error(`Please switch your wallet network to BNB Testnet (chainId ${FOURMEME_CHAIN_ID}).`);
        }
      } else {
        setChainOk(true);
      }

      setAddress(userAddress);
      localStorage.setItem('kairos_address', userAddress);
      toast.success('Wallet connected!');
      refreshBalance();
      return userAddress;
    } catch (error: any) {
      console.error('Connection failed:', error);
      toast.error('Failed to connect wallet');
      return null;
    }
  }, [refreshBalance]);

  const connectPrompt = useCallback(async () => {
    const eth = (window as any).ethereum;
    if (!eth) {
      toast.error('No EVM wallet detected. Please install MetaMask (or a compatible wallet).');
      return null;
    }
    try {
      // This forces MetaMask to show the permissions/account selector UI again.
      await eth.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // If user rejects, fall back to normal connect flow.
    }
    return await connect();
  }, [connect]);

  const signIn = useCallback(async () => {
    try {
      const eth = (window as any).ethereum;
      if (!eth) {
        toast.error('No EVM wallet detected. Please install MetaMask (or a compatible wallet).');
        return null;
      }

      // Ensure we have an address (connect may be silent if already authorized).
      const addr = address || (await connect());
      if (!addr) return null;

      // Ensure provider is initialized
      providerRef.current = providerRef.current || new ethers.BrowserProvider(eth);
      const signer = await providerRef.current.getSigner();

      // This always triggers a wallet popup.
      const issuedAt = new Date().toISOString();
      const msg =
        `Kairos Sign-In\n` +
        `Address: ${addr}\n` +
        `Issued At: ${issuedAt}\n` +
        `Purpose: prove wallet control to enable agent actions`;
      const sig = await signer.signMessage(msg);
      toast.success('Signed in!');
      return sig;
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      if (msg.toLowerCase().includes('user rejected')) toast.error('Signature rejected');
      else toast.error('Sign-in failed');
      return null;
    }
  }, [address, connect]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setBalance("0.0000");
    localStorage.removeItem('kairos_address');
    toast.info('Wallet disconnected');
  }, []);

  return (
    <WalletContext.Provider value={{
      isConnected: !!address,
      address,
      balance,
      connect,
      connectPrompt,
      signIn,
      disconnect,
      refreshBalance,
      chainOk
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
