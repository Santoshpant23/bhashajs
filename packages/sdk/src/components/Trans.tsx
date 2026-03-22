// FILE: packages/sdk/src/components/Trans.tsx
//
// An alternative way to translate text — as a React component
// instead of a function call.
//
// WHEN TO USE t() vs <Trans>:
//
// Use t() for simple text:
//   <h1>{t('hero.title')}</h1>
//   <p>{t('greeting', { name: 'Rohan' })}</p>
//
// Use <Trans> when you want it to feel more declarative:
//   <Trans id="hero.title" />
//   <Trans id="greeting" params={{ name: 'Rohan' }} />
//
// <Trans> also supports a `as` prop to render as a specific element:
//   <Trans id="hero.title" as="h1" />
//   → renders as <h1>स्वागत</h1>
//
// Both use the exact same translation logic under the hood.
// It's purely a developer preference thing.

import { createElement, ElementType } from "react";
import { useTranslation } from "../hooks/useTranslation";

interface TransProps {
  /** The translation key */
  id: string;
  /** Interpolation parameters */
  params?: Record<string, string | number>;
  /** Render as a specific HTML element (default: "span") */
  as?: ElementType;
  /** Additional props passed to the rendered element */
  [key: string]: any;
}

export function Trans({ id, params, as: Component = "span", ...rest }: TransProps) {
  const { t } = useTranslation();

  // Remove our custom props before spreading to the DOM element
  const { ...domProps } = rest;

  return createElement(Component, domProps, t(id, params));
}
