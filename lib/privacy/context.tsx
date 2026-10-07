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

  // Follow the toggle made in another open tab (the storage event fires only
  // in the OTHER documents of the same origin). A wiped store (key null)
  // is ignored (never fail open and unmask figures on a store wipe).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setIsPrivate(e.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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
