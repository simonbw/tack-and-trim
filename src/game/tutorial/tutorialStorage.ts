const TUTORIAL_COMPLETED_KEY = "tutorialCompleted";

export function isTutorialCompleted(): boolean {
  return localStorage.getItem(TUTORIAL_COMPLETED_KEY) === "true";
}

export function markTutorialCompleted(): void {
  localStorage.setItem(TUTORIAL_COMPLETED_KEY, "true");
}

export function resetTutorialCompleted(): void {
  localStorage.removeItem(TUTORIAL_COMPLETED_KEY);
}
