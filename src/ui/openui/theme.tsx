// Gives OpenUI components the Canvas chart palette and the current mode. OpenUI reads both from a theme context that
// only its ThemeProvider fills, and ThemeProvider injects style elements; scripts/build.mjs exposes that context
// instead. Without the build (tests, the generator) components keep OpenUI's defaults.
import React, { useMemo, type Context, type ReactNode } from 'react';
import * as genui from '@openuidev/react-ui/genui-lib';
import { THEME_PALETTES } from '../html/document';

type ThemeValue = { theme: Record<string, unknown>; mode: 'light' | 'dark'; portalThemeClassName: string };
const exposed = genui as unknown as { __canvasThemeContext?: Context<ThemeValue>; __canvasLightTheme?: Record<string, unknown> };

// OpenUI picks a chart's n colors from the middle of the palette outward. In this order every n from one to six is
// a run of distinct Canvas chart colors, and two series get chart-1 and chart-2, as in HTML views.
const ORDER = ['--chart-6', '--chart-5', '--chart-1', '--chart-3', '--chart-2', '--chart-4'];
const PALETTE_KEYS = ['defaultChartPalette', 'barChartPalette', 'lineChartPalette', 'areaChartPalette', 'pieChartPalette', 'radarChartPalette', 'radialChartPalette'];

export function chartPalette(mode: 'light' | 'dark') {
  return ORDER.map(name => THEME_PALETTES[mode][name]);
}

export function OpenUITheme({ mode, children }: { mode: 'light' | 'dark'; children: ReactNode }) {
  const value = useMemo<ThemeValue>(() => {
    const palette = chartPalette(mode);
    return { theme: { ...exposed.__canvasLightTheme, ...Object.fromEntries(PALETTE_KEYS.map(key => [key, palette])) }, mode, portalThemeClassName: '' };
  }, [mode]);
  const Provider = exposed.__canvasThemeContext?.Provider;
  return Provider ? <Provider value={value}>{children}</Provider> : <>{children}</>;
}
