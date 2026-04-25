import { useEffect, useState } from "react";
import { AppSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "../lib/clientStore";

export function useSettingsState() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  useEffect(() => {
    saveSettings(settings);
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const resetSettings = () => setSettings(DEFAULT_SETTINGS);

  return {
    settings,
    setSettings,
    updateSetting,
    resetSettings,
  };
}
