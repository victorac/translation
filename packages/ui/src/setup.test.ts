import { describe, expect, it } from "vitest";
import { initialSetup, newModel, settingsOf, withSettings } from "./setup";

describe("withSettings", () => {
  const remembered = { ...initialSetup, models: [newModel("my-model")] };
  it("keeps the remembered models when the project has none", () => {
    const project = settingsOf({ ...initialSetup, models: [] });
    expect(withSettings(remembered, project).models.map((m) => m.name)).toEqual(["my-model"]);
  });
  it("uses the project's own models when it has some", () => {
    const project = settingsOf({ ...initialSetup, models: [newModel("saved-model")] });
    expect(withSettings(remembered, project).models.map((m) => m.name)).toEqual(["saved-model"]);
  });
});
