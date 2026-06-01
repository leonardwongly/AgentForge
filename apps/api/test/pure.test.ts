import { describe, expect, it } from "vitest";
import {
  countBy,
  groupBy,
  headerValue,
  metricLine,
  percent,
  prometheusLabelValue
} from "../src/pure.js";

describe("api pure helpers", () => {
  it("countBy and groupBy tally occurrences by key", () => {
    const items = ["a", "b", "a", "c", "b", "a"];
    const expected = { a: 3, b: 2, c: 1 };
    expect(countBy(items, (value) => value)).toEqual(expected);
    expect(groupBy(items, (value) => value)).toEqual(expected);
  });

  it("countBy and groupBy tolerate missing item arrays", () => {
    expect(countBy(null, (value: string) => value)).toEqual({});
    expect(groupBy(undefined, (value: string) => value)).toEqual({});
  });

  it("percent rounds and guards divide-by-zero", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 3)).toBe(33);
    expect(percent(5, 0)).toBe(0);
    expect(percent(0, 0)).toBe(0);
  });

  it("prometheusLabelValue escapes backslashes, quotes, and newlines", () => {
    expect(prometheusLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it("metricLine renders bare and labeled samples", () => {
    expect(metricLine("m", {}, 3)).toBe("m 3");
    expect(metricLine("m", { route: "/x" }, 2)).toBe('m{route="/x"} 2');
  });

  it("headerValue returns the first value for arrays", () => {
    expect(headerValue(["a", "b"])).toBe("a");
    expect(headerValue("a")).toBe("a");
    expect(headerValue(undefined)).toBeUndefined();
  });
});
