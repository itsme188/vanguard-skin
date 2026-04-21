"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "vgs:privacyMode";

interface PrivacyContextValue {
  isPrivate: boolean;
  setPrivate: (next: boolean) => void;
  toggle: () => void;
}

const PrivacyContext = createContext<PrivacyContextValue | null>(null);

export function usePrivacy(): PrivacyContextValue {
  const ctx = useContext(PrivacyContext);
  if (!ctx) throw new Error("usePrivacy must be used within PrivacyProvider");
  return ctx;
}

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [isPrivate, setIsPrivate] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "1") setIsPrivate(true);
    } catch {}
  }, []);

  const setPrivate = useCallback((next: boolean) => {
    setIsPrivate(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {}
  }, []);

  const toggle = useCallback(() => {
    setIsPrivate((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  return (
    <PrivacyContext.Provider value={{ isPrivate, setPrivate, toggle }}>
      {children}
    </PrivacyContext.Provider>
  );
}
