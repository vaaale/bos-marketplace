// The custom-style tools (v4, FR-030 → FR-034).
//
// Everything Settings → Custom Styles can do, the agent can do too: list, add,
// update (CSS and name), remove, and reset a built-in. Before these existed the
// registry had exactly one writer — the Settings panel — so "make the Note
// boxes purple" was something the agent could only explain.
//
// Three rules run through all five:
//
//   * BUILT-IN NAMES ARE STRUCTURAL. Note/Info/Warning/Tip ship in code, so the
//     name cannot be taken, renamed or removed — only its CSS overridden, and
//     only reversibly (ADR-2). Each refusal names the tool that DOES apply, so
//     a refused call turns into the right call rather than a retry.
//   * THE STORE'S ACTIONS ARE SILENT ON BAD INPUT. `addStyle` returns without
//     doing anything for a built-in name, `updateStyle` for a name it doesn't
//     hold. A handler that dispatched and reported `ok` would be telling the
//     model it changed something it did not — so every handler validates first
//     and then VERIFIES the registry afterwards.
//   * A STYLE IS NOT A DOCUMENT. These write the app's own key/value store, not
//     the VFS, and take effect immediately in every open preview — there is no
//     save step and nothing to dirty. (`customStylesVersion`, bumped by each
//     store action, is what re-renders.)

import {
  builtinDefaultCss,
  effectiveCss,
  getBuiltinNames,
  getUserStyles,
  isBuiltin,
  isOverridden,
  styleExists,
} from "../config/custom-styles";
import { useEditorStore } from "../state/document-store";
import type { ToolDeclaration, ToolHandler } from "../types";
import { fail, guarded, ok, str } from "./result";

/** One registry entry, as the model sees it. */
interface StyleRecord {
  name: string;
  kind: "builtin" | "user";
  /** The CSS currently in effect — a built-in's override when it has one. */
  css: string;
  /** Built-ins only: true when the CSS is the user's, not the shipped default. */
  overridden?: boolean;
}

function describeStyle(name: string): StyleRecord {
  const builtin = isBuiltin(name);
  return {
    name,
    kind: builtin ? "builtin" : "user",
    css: effectiveCss(name),
    ...(builtin ? { overridden: isOverridden(name) } : {}),
  };
}

/** Built-ins in display order, then the user's own, alphabetically. */
function allStyles(): StyleRecord[] {
  const user = Object.keys(getUserStyles()).sort((a, b) => a.localeCompare(b));
  return [...getBuiltinNames(), ...user].map(describeStyle);
}

/** Everything the registry holds — the context a refusal needs to be useful. */
function knownNames(): { builtin: string[]; user: string[] } {
  return { builtin: getBuiltinNames(), user: Object.keys(getUserStyles()).sort((a, b) => a.localeCompare(b)) };
}

/**
 * A name a document could never reference.
 *
 * A style is addressed as `::: {custom-style="Name"}` or `::: {.Name}`, and the
 * parser reads the quoted form with `[^"]*` — so a name carrying a quote, a
 * brace or a newline resolves to nothing at render time no matter what the
 * registry holds. Refusing it here is cheaper than a style that silently never
 * applies. (The class form is narrower still, but the quoted form is the one
 * these tools document, so that is what is enforced.)
 */
const UNREFERENCEABLE = /["'{}\n\r]/;

function validName(raw: string | undefined, field: string): string {
  const name = (raw ?? "").trim();
  if (!name) throw new Error(`\`${field}\` is required — a style is referenced by name.`);
  if (UNREFERENCEABLE.test(name)) {
    throw new Error(
      `"${name}" cannot be used as a style name: quotes, braces and newlines make it unreferenceable in ::: {custom-style="…"}.`,
    );
  }
  return name;
}

/** A CSS declaration block argument — the thing that goes in `style="…"`. */
function cssArg(args: Record<string, unknown>): string | undefined {
  const css = args.css;
  return typeof css === "string" && css.trim() ? css : undefined;
}

// ------------------------------------------------------------------ declarations

const STYLE_SYNTAX = '::: {custom-style="Name"} … :::';

export const STYLE_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "agentic_editor_list_styles",
    description:
      `List every named style documents can use with ${STYLE_SYNTAX}, with the CSS each one currently resolves to. ` +
      "Call this before changing a style — editing CSS means editing what is already there. " +
      "Built-in styles (Note, Info, Warning, Tip) ship with the app: their names are fixed, their CSS can be overridden and reset.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "agentic_editor_add_style",
    description:
      "Create a new named style. The name is what documents reference; `css` is a plain declaration block (no selector, no braces), " +
      'e.g. "background: #1e293b; border-left: 3px solid #38bdf8; padding: 12px 16px;". ' +
      "Takes effect in every open preview immediately — styles are app settings, not document content, so there is nothing to save.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: 'The style name, e.g. "Callout". Must not already exist.' },
        css: { type: "string", description: "CSS declarations, separated by semicolons. No selector and no braces." },
      },
      required: ["name", "css"],
    },
  },
  {
    name: "agentic_editor_update_style",
    description:
      "Change an existing style's CSS, its name, or both. `css` REPLACES the declaration block — to tweak one property, read the current " +
      "CSS with agentic_editor_list_styles and send it back with that property changed. A built-in's CSS can be overridden (undo with " +
      "agentic_editor_reset_style); a built-in's name cannot be changed.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The style to change." },
        css: { type: "string", description: "The replacement declaration block. Omit to keep the current CSS." },
        newName: { type: "string", description: "Rename the style to this. User styles only." },
      },
      required: ["name"],
    },
  },
  {
    name: "agentic_editor_remove_style",
    description:
      "Delete a user-defined style. Documents that still name it keep their content and render as a neutral box. " +
      "Built-in styles cannot be removed — reset them instead.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The user style to delete." } },
      required: ["name"],
    },
  },
  {
    name: "agentic_editor_reset_style",
    description:
      "Put a built-in style (Note, Info, Warning, Tip) back to the CSS the app ships with, discarding any override. " +
      "Resetting one that was never overridden changes nothing and says so.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The built-in style to reset." } },
      required: ["name"],
    },
  },
];

// ------------------------------------------------------------------ handlers

export const STYLE_TOOL_HANDLERS: Record<string, ToolHandler> = {
  agentic_editor_list_styles: guarded(async () => {
    const styles = allStyles();
    return ok({
      styles,
      syntax: STYLE_SYNTAX,
      message: `${styles.length} style(s): ${styles.map((s) => s.name).join(", ")}.`,
    });
  }),

  agentic_editor_add_style: guarded(async (args) => {
    const name = validName(str(args, "name"), "name");
    const css = cssArg(args);
    if (!css) return fail("`css` is required — a style with no declarations would render as a plain box.");

    if (isBuiltin(name)) {
      return fail(`"${name}" is a built-in style and always exists.`, {
        hint: `Call agentic_editor_update_style to give "${name}" different CSS, or pick another name.`,
        ...knownNames(),
      });
    }
    if (styleExists(name)) {
      return fail(`"${name}" already exists.`, {
        hint: `Call agentic_editor_update_style to change it, or add it under a different name.`,
        current: describeStyle(name),
      });
    }

    useEditorStore.getState().addStyle(name, css);
    if (!styleExists(name)) return fail(`The style registry did not accept "${name}".`);

    return ok({
      style: describeStyle(name),
      message: `Added "${name}". Use it with ::: {custom-style="${name}"} … :::`,
    });
  }),

  agentic_editor_update_style: guarded(async (args) => {
    const name = validName(str(args, "name"), "name");
    const css = cssArg(args);
    const newNameRaw = str(args, "newName");
    if (!css && !newNameRaw) {
      return fail("Nothing to change — pass `css`, `newName`, or both.");
    }

    const store = useEditorStore.getState();

    // ---- a built-in: its CSS is overridable, its name is not.
    if (isBuiltin(name)) {
      if (newNameRaw && newNameRaw.trim() !== name) {
        return fail(`"${name}" is a built-in style and its name is fixed.`, {
          hint: `Create a differently-named style with agentic_editor_add_style, or change this one's CSS with \`css\`.`,
        });
      }
      if (!css) return fail("Nothing to change — pass `css`.");

      store.overrideBuiltIn(name, css);
      if (effectiveCss(name) !== css) return fail(`The style registry did not accept the CSS for "${name}".`);

      const style = describeStyle(name);
      return ok({
        style,
        message: style.overridden
          ? `"${name}" now uses your CSS. Undo with agentic_editor_reset_style.`
          : `"${name}" is back to the CSS the app ships with — that is what you sent.`,
      });
    }

    // ---- a user style: may be re-styled, renamed, or both.
    if (!styleExists(name)) {
      return fail(`There is no style called "${name}".`, {
        hint: "Call agentic_editor_add_style to create it, or agentic_editor_list_styles to see what exists.",
        ...knownNames(),
      });
    }

    const nextCss = css ?? effectiveCss(name);
    const newName = newNameRaw ? validName(newNameRaw, "newName") : name;

    if (newName === name) {
      store.updateStyle(name, nextCss);
      if (effectiveCss(name) !== nextCss) return fail(`The style registry did not accept the CSS for "${name}".`);
      return ok({ style: describeStyle(name), message: `Updated "${name}".` });
    }

    if (styleExists(newName)) {
      return fail(`Cannot rename "${name}" to "${newName}" — that name is taken.`, { ...knownNames() });
    }

    // A rename is remove + add, in that order: the registry is keyed by name,
    // so the CSS has to be carried across explicitly.
    store.removeStyle(name);
    store.addStyle(newName, nextCss);
    if (styleExists(name) || !styleExists(newName)) {
      return fail(`The rename of "${name}" to "${newName}" did not take effect.`);
    }

    return ok({
      style: describeStyle(newName),
      renamedFrom: name,
      message:
        `Renamed "${name}" to "${newName}". Documents still written as ::: {custom-style="${name}"} ` +
        "now render as a neutral box — update them too if that is not what you want.",
    });
  }),

  agentic_editor_remove_style: guarded(async (args) => {
    const name = validName(str(args, "name"), "name");

    if (isBuiltin(name)) {
      return fail(`"${name}" is a built-in style and cannot be removed.`, {
        hint: isOverridden(name)
          ? `Call agentic_editor_reset_style to drop your override and restore the shipped CSS.`
          : `It is already at its shipped CSS; agentic_editor_reset_style is the only thing to undo here.`,
      });
    }
    if (!styleExists(name)) {
      return fail(`There is no style called "${name}".`, { ...knownNames() });
    }

    useEditorStore.getState().removeStyle(name);
    if (styleExists(name)) return fail(`"${name}" could not be removed.`);

    return ok({
      removed: name,
      message:
        `Removed "${name}". Documents that still name it keep their content and render as a neutral box.`,
    });
  }),

  agentic_editor_reset_style: guarded(async (args) => {
    const name = validName(str(args, "name"), "name");

    if (!isBuiltin(name)) {
      return fail(`"${name}" is not a built-in style, so there is no shipped CSS to go back to.`, {
        hint: styleExists(name)
          ? `Use agentic_editor_update_style to change it or agentic_editor_remove_style to delete it.`
          : "Call agentic_editor_list_styles to see what exists.",
        ...knownNames(),
      });
    }

    const changed = isOverridden(name);
    useEditorStore.getState().resetBuiltIn(name);
    if (isOverridden(name)) return fail(`The override on "${name}" could not be cleared.`);
    if (effectiveCss(name) !== builtinDefaultCss(name)) {
      return fail(`"${name}" did not go back to its shipped CSS.`);
    }

    return ok({
      style: describeStyle(name),
      changed,
      message: changed ? `"${name}" is back to its shipped CSS.` : `"${name}" was already at its shipped CSS.`,
    });
  }),
};
