'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function EvaluationStatusRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(interval);
  }, [active, router]);
  return null;
}
