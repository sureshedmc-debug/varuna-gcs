# Technical Design: Modern Light Theme for Varuna GCS

## Overview

This design document specifies the technical implementation for a modern, professional light theme in the Varuna GCS application. The theme will transform the existing dark, gold-accented interface into a clean, bright interface with blue accents suitable for professional drone operations.

The implementation leverages the existing CSS custom property-based theme system and focuses on updating variable definitions in `src/index.css` to achieve the desired aesthetic. The theme will maintain full compatibility with the existing theme switching mechanism and preserve all existing functionality.

## Architecture

### Theme System Structure

The Varuna GCS theme system operates through:

1. **CSS Custom Properties**: Defined in `:root` and `:root[data-theme='light']` selectors in `src/index.css`
2. **Theme Toggle Component**: `src/components/ThemeToggle.jsx` provides user interface for switching themes
3. **Theme Management**: `src/lib/theme.js` handles persistence and application of theme selection
4. **Tailwind Integration**: `tailwind.config.js` references CSS custom properties for consistent color usage

### Implementation Scope

**Included in Scope:**
- CSS variable updates in `src/index.css`
- Light theme color palette definition
- Glass panel and UI component styling
- Ambient background effects
- Input field and interactive element styling
- Scrollbar and focus ring styling

**Excluded from Scope:**
- Dark theme modifications
- Electron application styling (electron/ directory)
- Component JavaScript logic changes
- Theme switching mechanism modifications

## Components and Interfaces

### CSS Custom Property Interface

The theme system exposes these key custom properties:

```css
/* Background Colors */
--base: /* Primary background color */
--panel: /* Secondary panel surfaces */

/* Text Colors (RGB channels for Tailwind opacity support) */
--ink: /* Primary text color */
--muted: /* Secondary text color */
--faint: /* Tertiary text color */

/* Accent Colors */
--accent: /* Primary accent (RGB channels) */
--accent-hex: /* Primary accent (hex value) */
--accent2: /* Secondary accent highlight */

/* UI Element Colors */
--line: /* Border colors */
--chip: /* Chip backgrounds */
--chip2: /* Chip hover states */
--glass-bg: /* Glass panel backgrounds */
--glass-border: /* Glass panel borders */
--inp-bg: /* Input backgrounds */
--inp-border: /* Input borders */
--scroll: /* Scrollbar colors */

/* Ambient Effects */
--amb1, --amb2, --amb3, --amb4: /* Gradient overlay colors */
```

### Component Integration Points

**Glass Components (`TiltCard`, panels):**
- Use `--glass-bg` and `--glass-border` for consistent glass effects
- Maintain backdrop blur and shadow effects

**Interactive Elements (`Btn`, inputs):**
- Primary buttons use `--accent` and `--accent2` for gradients
- Focus states use `--accent-hex` for rings and glows
- Input fields use `--inp-bg` and `--inp-border`

**Status Components (`StatusOrb`, `StaleBadge`):**
- Preserve semantic colors (green/amber/red) regardless of theme
- Use theme-aware backgrounds for badges

**Command System (`CommandPanel`, `CommandButton`):**
- Maintain existing command-specific color schemes
- Apply theme-aware backgrounds to panels

## Data Models

### Color Palette Specification

**Primary Colors:**
```css
--base: #FFFFFF;          /* Pure white background */
--panel: #F8FAFC;         /* Light gray panels (slate-50) */
--accent: 0 191 255;      /* Bright sky blue RGB (#00BFFF) */
--accent-hex: #00BFFF;    /* Bright sky blue hex */
--accent2: #0EA5E9;       /* Sky-500 for highlights */
```

**Text Colors:**
```css
--ink: 15 23 42;          /* Dark slate (slate-800) RGB */
--muted: 100 116 139;     /* Medium slate (slate-500) RGB */
--faint: 148 163 184;     /* Light slate (slate-400) RGB */
```

**UI Element Colors:**
```css
--line: rgba(148, 163, 184, 0.3);     /* Light borders */
--chip: rgba(0, 191, 255, 0.08);      /* Blue-tinted chips */
--chip2: rgba(0, 191, 255, 0.15);     /* Blue hover chips */
--glass-bg: rgba(255, 255, 255, 0.95); /* Clean white glass */
--glass-border: rgba(148, 163, 184, 0.2); /* Subtle glass borders */
--inp-bg: rgba(255, 255, 255, 1);     /* Pure white inputs */
--inp-border: rgba(148, 163, 184, 0.3); /* Light input borders */
--scroll: rgba(148, 163, 184, 0.4);   /* Scrollbar color */
```

**Ambient Effects:**
```css
--amb1: rgba(0, 191, 255, 0.03);      /* Top-left subtle blue */
--amb2: rgba(14, 165, 233, 0.02);     /* Top-right deeper blue */
--amb3: rgba(0, 191, 255, 0.02);      /* Bottom-center bright blue */
--amb4: rgba(14, 165, 233, 0.01);     /* Bottom-right subtle blue */
```

### Color Rationale

**Blue Accent Choice:**
- `#00BFFF` (Deep Sky Blue): Professional, high-tech appearance suitable for aerospace applications
- High contrast against white backgrounds for excellent visibility
- Distinct from status colors (green/amber/red) to avoid confusion
- Modern, energetic feel appropriate for operational software

**Gray Scale Selection:**
- Tailwind's slate color scale provides excellent readability and professional appearance
- Consistent with modern design systems and UI frameworks
- Maintains visual hierarchy through appropriate contrast levels

## Implementation Details

### CSS Variable Updates

The complete light theme CSS custom property block:

```css
:root[data-theme='light'] {
  color-scheme: light;
  
  /* ── Backgrounds ── */
  --base:   #FFFFFF;          /* pure white background */
  --panel:  #F8FAFC;          /* very light gray panel surface */

  /* ── Text ── */
  --ink:    15 23 42;         /* slate-800 - dark text for excellent readability */
  --muted:  100 116 139;      /* slate-500 - muted text */
  --faint:  148 163 184;      /* slate-400 - faint text */

  /* ── Borders & chips ── */
  --line:   rgba(148, 163, 184, 0.3);   /* light border */
  --chip:   rgba(0, 191, 255, 0.08);    /* sky blue tinted chip bg */
  --chip2:  rgba(0, 191, 255, 0.15);    /* sky blue hover chip */

  /* ── Glass panels ── */
  --glass-bg:     rgba(255, 255, 255, 0.95);    /* clean white glass */
  --glass-soft:   rgba(248, 250, 252, 0.90);    /* soft light gray glass */
  --glass-border: rgba(148, 163, 184, 0.2);     /* subtle border */

  /* ── Inputs ── */
  --inp-bg:     rgba(255, 255, 255, 1);
  --inp-border: rgba(148, 163, 184, 0.3);
  --inp-ph:     #94A3B8;

  /* ── PRIMARY ACCENT: BRIGHT BLUE ── */
  --accent:      0 191 255;      /* #00BFFF  bright sky blue rgb channels */
  --accent-hex:  #00BFFF;
  --accent2:     #0EA5E9;        /* sky-500 - deeper blue highlight */

  /* ── Scrollbar ── */
  --scroll: rgba(148, 163, 184, 0.4);

  /* ── Ambient glow — subtle blue halos ── */
  --amb1: rgba(0, 191, 255, 0.03);      /* top-left subtle blue */
  --amb2: rgba(14, 165, 233, 0.02);     /* top-right deeper blue */
  --amb3: rgba(0, 191, 255, 0.02);      /* bottom-centre bright blue */
  --amb4: rgba(14, 165, 233, 0.01);     /* bottom-right subtle blue */
}
```

### Background Gradient Updates

Light theme body background gradients:

```css
/* Light theme background gradients */
:root[data-theme='light'] body {
  /* subtle blue radial glow for light theme */
  background-image:
    radial-gradient(ellipse 90% 50% at 50% -5%,  rgba(0,191,255,0.02), transparent 65%),
    radial-gradient(ellipse 60% 40% at 100% 0%,   rgba(14,165,233,0.015), transparent 60%),
    radial-gradient(ellipse 55% 35% at 0%   100%, rgba(0,191,255,0.015), transparent 60%);
}
```

### Interactive Element Updates

**Scrollbar Hover Effects:**
```css
/* Light theme scrollbar hover */
:root[data-theme='light'] ::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 191, 255, 0.7);
  box-shadow: 0 0 6px rgba(0, 191, 255, 0.5);
}
```

**Focus Ring Updates:**
```css
/* Light theme focus ring */
:root[data-theme='light'] button:focus-visible {
  outline: 2px solid rgba(0, 191, 255, 0.7);
  outline-offset: 2px;
}
```

**Input Focus Effects:**
```css
/* Light theme input focus (within .inp:focus rule) */
:root[data-theme='light'] .inp:focus {
  border-color: #00BFFF;
  box-shadow:
    0 0 0 3px rgba(0, 191, 255, 0.18),
    0 0 14px rgba(0, 191, 255, 0.14);
}
```

**Scanline Effect:**
```css
/* Light theme scanline */
:root[data-theme='light'] body::after {
  background: linear-gradient(90deg, transparent 0%, rgba(0,191,255,0.6) 50%, transparent 100%);
}
```

### File Modification Strategy

**Single File Update:**
- All changes confined to `src/index.css`
- Update only the `:root[data-theme='light']` selector block
- Add theme-specific overrides for interactive elements
- Preserve all existing dark theme definitions

**Implementation Order:**
1. Update core color variables (backgrounds, text, accent)
2. Update UI element colors (borders, chips, glass)
3. Update input and interactive element colors
4. Update ambient effect colors
5. Update theme-specific CSS rules (gradients, focus, hover effects)

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Property-based testing is not applicable to this feature. This implementation involves UI styling and visual appearance modifications through CSS variable updates, which falls into the category of UI rendering and layout changes. 

According to property-based testing best practices, UI rendering and layout features should NOT use property-based testing because:

- CSS styling changes are declarative configuration, not functions with clear input/output behavior
- Visual appearance does not have universal properties that hold across generated inputs  
- The correctness is subjective and based on design requirements rather than algorithmic logic
- Alternative testing approaches (snapshot tests, visual regression tests, manual testing) are more appropriate and effective

Instead of property-based testing, this feature should be verified through:
- **Snapshot tests** to capture visual state
- **Visual regression tests** to detect unintended changes
- **Manual testing** to verify user experience and accessibility
- **Integration tests** to verify theme switching functionality

The comprehensive testing approach is detailed in the Testing Strategy section.

## Error Handling

### Theme Loading Fallbacks

The existing theme system provides robust error handling:

```javascript
// From src/lib/theme.js
export function getTheme() {
  try {
    return localStorage.getItem('varuna.theme') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'  // Falls back to dark theme if localStorage unavailable
  }
}
```

### CSS Variable Fallbacks

All CSS custom properties should include fallback values where appropriate:

```css
color: rgb(var(--ink, 15 23 42));  /* Fallback to slate-800 */
background: var(--base, #FFFFFF);   /* Fallback to white */
border-color: var(--line, rgba(148, 163, 184, 0.3)); /* Fallback border */
```

### Color Scheme Validation

The `color-scheme` CSS property ensures browser UI elements (scrollbars, form controls) match the theme:

```css
:root[data-theme='light'] {
  color-scheme: light;  /* Tells browser to use light native controls */
}
```

## Testing Strategy

### Manual Testing Approach

Since this feature involves UI styling without complex business logic, property-based testing is not applicable. The testing strategy will focus on:

**Visual Regression Testing:**
- Compare screenshots of all major UI screens between dark and light themes
- Verify color contrast ratios meet WCAG AA standards (4.5:1 for normal text, 3:1 for large text)
- Test theme switching functionality in various browsers

**Component Integration Testing:**
- Verify all UI components render correctly in light theme
- Test glass panel transparency and backdrop effects
- Validate input field focus states and interactive hover effects
- Confirm ambient background effects are subtle and professional

**Cross-Browser Compatibility:**
- Test in Chrome, Firefox, Safari, and Edge
- Verify CSS custom property support and backdrop-filter effects
- Validate color rendering consistency across different displays

**Accessibility Testing:**
- Use browser developer tools to verify contrast ratios
- Test keyboard navigation with focus rings
- Verify screen reader compatibility with color scheme changes
- Test with high contrast OS settings

**Performance Testing:**
- Measure theme switching performance (should be <100ms)
- Verify CSS transitions are smooth and don't impact frame rates
- Test memory usage with background gradient effects

### Theme Switching Test Cases

**Functional Tests:**
1. **Theme persistence**: Switch to light theme, refresh browser, verify theme is maintained
2. **Real-time switching**: Toggle theme while using various screens, verify immediate visual updates
3. **Component state preservation**: Switch themes during interactions (open modals, focused inputs), verify state is maintained
4. **Multiple window support**: Open multiple browser tabs, verify theme changes sync across all tabs

**Visual Tests:**
1. **Color accuracy**: Verify all accent colors use specified blue (#00BFFF)
2. **Text readability**: Confirm all text meets contrast requirements
3. **Glass panel effects**: Verify backdrop blur and transparency work correctly
4. **Interactive states**: Test hover, focus, and active states for all interactive elements

### Test Environment Setup

**Development Testing:**
```bash
# Start development server to test theme changes
npm run dev
# Access at http://localhost:5173 (web-only changes)
```

**Build Verification:**
```bash
# Build and test production version
npm run build
npm run preview
```

The Electron application should remain completely unaffected by these changes, as all modifications are CSS-only and scoped to the web version.