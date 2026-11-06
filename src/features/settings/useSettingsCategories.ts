import { useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { useAuthStatusConfig } from '@/lib/qrConfig';
import { usePermissions } from '@/lib/usePermissions';
import { filterCategories } from './settingsCategories';

export function useSettingsCategories() {
  const { user } = useAuth();
  const { config: { localMode } } = useAuthStatusConfig();
  const { isAdmin } = usePermissions();

  const isSiteAdmin = !!user?.isAdmin;
  const isEE = typeof __EE__ !== 'undefined' && __EE__;

  const categories = useMemo(
    () => filterCategories({ localMode, isAdmin, isEE, isSiteAdmin }),
    [localMode, isAdmin, isEE, isSiteAdmin],
  );

  const mainCategories = useMemo(
    () => categories.filter((c) => !c.adminSection),
    [categories],
  );

  const adminCategories = useMemo(
    () => categories.filter((c) => c.adminSection),
    [categories],
  );

  return { categories, mainCategories, adminCategories };
}
