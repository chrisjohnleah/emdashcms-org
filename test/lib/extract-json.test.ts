import { describe, it, expect } from "vitest";
import { extractJsonFromResponse } from "../../src/lib/audit/prompt";

const SAMPLE = { verdict: "pass", riskScore: 10, findings: [] };

describe("extractJsonFromResponse", () => {
  it("parses pure JSON", () => {
    expect(extractJsonFromResponse(JSON.stringify(SAMPLE))).toEqual(SAMPLE);
  });

  it("parses JSON with leading/trailing whitespace", () => {
    expect(extractJsonFromResponse("\n\n  " + JSON.stringify(SAMPLE) + "  \n")).toEqual(SAMPLE);
  });

  it("strips ```json fences", () => {
    const wrapped = "```json\n" + JSON.stringify(SAMPLE) + "\n```";
    expect(extractJsonFromResponse(wrapped)).toEqual(SAMPLE);
  });

  it("strips plain ``` fences", () => {
    const wrapped = "```\n" + JSON.stringify(SAMPLE) + "\n```";
    expect(extractJsonFromResponse(wrapped)).toEqual(SAMPLE);
  });

  it("recovers JSON after a prose preamble", () => {
    const text = "Here is the audit result:\n\n" + JSON.stringify(SAMPLE);
    expect(extractJsonFromResponse(text)).toEqual(SAMPLE);
  });

  it("recovers JSON before trailing prose", () => {
    const text = JSON.stringify(SAMPLE) + "\n\nLet me know if you need anything else.";
    expect(extractJsonFromResponse(text)).toEqual(SAMPLE);
  });

  it("recovers JSON sandwiched between prose blocks", () => {
    const text = "Sure! Here's what I found:\n" + JSON.stringify(SAMPLE) + "\nThanks.";
    expect(extractJsonFromResponse(text)).toEqual(SAMPLE);
  });

  it("handles nested objects in findings", () => {
    const complex = {
      verdict: "warn",
      riskScore: 45,
      findings: [
        {
          severity: "medium",
          title: "Test",
          description: "x",
          category: "security",
          location: "src/index.ts",
        },
      ],
    };
    const text = "```json\n" + JSON.stringify(complex) + "\n```";
    expect(extractJsonFromResponse(text)).toEqual(complex);
  });

  it("handles strings containing braces", () => {
    const tricky = {
      verdict: "pass",
      riskScore: 0,
      findings: [
        {
          severity: "info",
          title: "Object literal { key: value }",
          description: "Found code matching {pattern}",
          category: "code-quality",
        },
      ],
    };
    expect(extractJsonFromResponse(JSON.stringify(tricky))).toEqual(tricky);
  });

  it("handles escaped quotes inside strings", () => {
    const tricky = {
      verdict: "pass",
      riskScore: 0,
      findings: [
        {
          severity: "info",
          title: 'String with "quotes"',
          description: "x",
          category: "code-quality",
        },
      ],
    };
    expect(extractJsonFromResponse(JSON.stringify(tricky))).toEqual(tricky);
  });

  it("returns null for empty input", () => {
    expect(extractJsonFromResponse("")).toBeNull();
    expect(extractJsonFromResponse("   ")).toBeNull();
    expect(extractJsonFromResponse(null as unknown as string)).toBeNull();
  });

  it("returns null for non-JSON text", () => {
    expect(extractJsonFromResponse("This is just prose, no JSON here.")).toBeNull();
  });

  it("returns null for malformed JSON without recovery", () => {
    expect(extractJsonFromResponse("{ verdict: pass }")).toBeNull();
  });

  it("returns null for unclosed JSON object", () => {
    expect(extractJsonFromResponse('{"verdict":"pass"')).toBeNull();
  });
});
