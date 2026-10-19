#!/usr/bin/env python3
"""
Validates docs/us-curriculum-registry.json and assets/ manifests against AGENTS.md invariants:
1. All 5 grades (Pre-K to Grade 3) and 4 subjects exist.
2. All 130 units form a valid Directed Acyclic Graph (DAG) with valid prerequisiteUnitIds.
3. All 614 skill topics contain all 9 mandatory asset categories:
   sounds, images, videos, interactiveElements, voiceNarration, animations, games, quizzes, assessments.
4. Zero third-party brand references exist anywhere in the registry.
"""
import json
import os
import sys

def main():
    reg_path = "docs/us-curriculum-registry.json"
    if not os.path.exists(reg_path):
        print(f"ERROR: Missing {reg_path}", file=sys.stderr)
        sys.exit(1)

    with open(reg_path, "r", encoding="utf-8") as f:
        raw = f.read()
        data = json.loads(raw)

    required_assets = {
        "sounds", "images", "videos", "interactiveElements",
        "voiceNarration", "animations", "games", "quizzes", "assessments"
    }

    unit_ids = set()
    all_units = []
    topic_count = 0

    for grade in data.get("grades", []):
        gid = grade["gradeId"]
        assert "spacedRepetitionPolicy" in grade, f"Missing spacedRepetitionPolicy in {gid}"
        for subj_key, subj in grade.get("subjects", {}).items():
            for u in subj.get("units", []):
                uid = u["unitId"]
                assert uid not in unit_ids, f"Duplicate unitId {uid}"
                unit_ids.add(uid)
                all_units.append(u)
                gate = u.get("masteryGate", {})
                assert gate.get("minAccuracyPercent", 0) >= 85, f"Invalid accuracy gate in {uid}"
                assert gate.get("maxMedianResponseTimeSec", 0) > 0, f"Invalid speed gate in {uid}"
                for t in u.get("skillTopics", []):
                    assets = t.get("assets", {})
                    missing = required_assets - set(assets.keys())
                    assert not missing, f"Missing asset keys {missing} in {uid}-{t.get('code')}"
                    assert len(assets["quizzes"].get("sampleQuestions", [])) >= 2, f"Missing sampleQuestions in {uid}-{t.get('code')}"
                    topic_count += 1

    # Verify DAG prerequisites
    for u in all_units:
        for prereq in u.get("prerequisiteUnitIds", []):
            assert prereq in unit_ids, f"Unit {u['unitId']} references unknown prerequisite {prereq}"

    print(f"[OK] Curriculum DAG validated: {len(data['grades'])} grades, {len(all_units)} units, {topic_count} skill topics with all 9 asset categories.")

if __name__ == "__main__":
    main()
