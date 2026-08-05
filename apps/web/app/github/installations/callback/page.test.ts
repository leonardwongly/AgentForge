import * as React from "react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { tsImport } from "tsx/esm/api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type GitHubInstallationCallback = (props: {
  searchParams?: Promise<{
    installation_id?: string;
    setup_action?: string;
  }>;
}) => Promise<ReactElement>;

type TestElement = ReactElement<
  Record<string, unknown> & {
    children?: ReactNode;
  }
>;

let renderCallback: GitHubInstallationCallback;

describe("GitHub installation callback", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const callbackModule = (await tsImport("./page.tsx", {
      parentURL: import.meta.url,
      tsconfig: false
    })) as { default: GitHubInstallationCallback };
    renderCallback = callbackModule.default;
  });

  beforeEach(() => {
    // These settings make the former render-time implementation resolve an
    // actor and reach fetch, so the no-fetch assertion catches the GET CSRF.
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR", "true");
    vi.stubEnv("AGENTFORGE_DASHBOARD_ROLE", "platform_admin");
    vi.stubEnv("AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS", "true");
    vi.stubGlobal("React", React);
    fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders a confirmation form without fetching or recording during GET rendering", async () => {
    const view = await renderCallback({
      searchParams: Promise.resolve({ installation_id: "12345678", setup_action: "install" })
    });

    expect(fetchMock).not.toHaveBeenCalled();

    const forms = findElements(view, "form");
    expect(forms).toHaveLength(1);
    expect(forms[0]?.props.action).toEqual(expect.any(Function));

    const hiddenValues = Object.fromEntries(
      findElements(forms[0], "input").map((input) => [input.props.name, input.props.value])
    );
    expect(hiddenValues).toEqual({
      githubInstallationId: "12345678",
      accountType: "Organization",
      returnTo: "/settings"
    });

    const submitButtons = findElements(forms[0], "button");
    expect(submitButtons).toHaveLength(1);
    expect(submitButtons[0]?.props.type).toBe("submit");
    expect(textContent(submitButtons[0])).toContain("Record installation");
    expect(textContent(view)).toContain("No installation has been recorded yet");
    expect(textContent(view)).toContain("must explicitly record it");
  });

  it("keeps a missing installation ID non-mutating and offers no confirmation form", async () => {
    const view = await renderCallback({ searchParams: Promise.resolve({}) });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(findElements(view, "form")).toHaveLength(0);
    expect(textContent(view)).toContain("GitHub did not return an installation ID");
  });

  it.each(["123abc", "-123", "123.4", "１２３", "1".repeat(21)])(
    "rejects malformed installation ID %s before offering confirmation",
    async (installationId) => {
      const view = await renderCallback({
        searchParams: Promise.resolve({ installation_id: installationId })
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(findElements(view, "form")).toHaveLength(0);
      expect(textContent(view)).toContain("GitHub returned an invalid installation ID");
    }
  );
});

function findElements(node: ReactNode, elementType: string): TestElement[] {
  const matches: TestElement[] = [];

  Children.forEach(node, (child) => {
    if (!isValidElement(child)) {
      return;
    }
    const element = child as TestElement;
    if (element.type === elementType) {
      matches.push(element);
    }
    matches.push(...findElements(element.props.children, elementType));
  });

  return matches;
}

function textContent(node: ReactNode): string {
  let text = "";

  Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      text += String(child);
      return;
    }
    if (isValidElement(child)) {
      text += textContent((child as TestElement).props.children);
    }
  });

  return text;
}
