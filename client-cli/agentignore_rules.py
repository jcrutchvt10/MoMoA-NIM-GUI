# Copyright 2026 Reto Meier
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import os
import pathlib

# --- Helper functions ---

def _parse_agentignore_line(line, origin_dir):
    """Parses a single line from a .agentignore file (simplified gitignore syntax)."""
    line = line.strip()
    if not line or line.startswith('#'):
        return None

    # Handle escaped # or ! at the beginning
    if line.startswith('\\#'):
         line = line[1:]
         is_include = False # Escaped, not include
    elif line.startswith('\\!'):
        line = line[1:]
        is_include = False # Escaped, not include
    else:
        is_include = line.startswith('!')
        if is_include:
            line = line[1:]

    # Strip trailing spaces (unless escaped, which we don't fully support here)
    line = line.rstrip()

    is_dir_only = line.endswith('/')
    if is_dir_only:
        line = line[:-1].rstrip() # Remove trailing slash and any spaces before it

    # Handle escaped leading /
    if line.startswith('\\/'):
        line = line[1:]
        is_anchored = False # Escaped, not anchored
    else:
         is_anchored = line.startswith('/')
         if is_anchored:
             line = line[1:]

    pattern = line
    rule_type = 'include' if is_include else 'exclude'

    # Special case: empty pattern after stripping -> invalid rule?
    if not pattern:
        # Treat empty pattern as invalid or ignore. Gitignore ignores.
        return None

    return {
        'pattern': pattern,
        'type': rule_type,
        'is_anchored': is_anchored,
        'is_dir_only': is_dir_only,
        'origin_dir': origin_dir # Directory where this .agentignore file is located (absolute path)
    }

def _parse_agentignore_file(filepath):
    """Reads and parses rules from a single .agentignore file."""
    rules = []
    origin_dir = os.path.dirname(filepath)
    try:
        # Use 'utf-8' encoding as is common for configuration files
        with open(filepath, 'r', encoding='utf-8') as f:
            for line in f:
                rule = _parse_agentignore_line(line, origin_dir)
                if rule:
                    rules.append(rule)
    except OSError:
        # File not found or other read error, return empty rules
        pass
    except UnicodeDecodeError:
        # Handle potential encoding issues
        print(f"Warning: Could not decode .agentignore file: {filepath}. Skipping.")
        pass
    return rules

def _find_agentignore_files_in_path(target_path, root_dir):
    """
    Finds all .agentignore files from root_dir up to directory containing target_path.
    Returns file paths in order from root downwards.
    """
    agentignore_files = []
    current_path = pathlib.Path(target_path).resolve()
    root = pathlib.Path(root_dir).resolve()

    # Start search from the directory containing the target_path
    if current_path.is_file():
        current_dir = current_path.parent
    else:
        # If target is a directory, rules up to *this* directory apply to its contents.
        # Rules in this directory's .agentignore apply to its contents.
        # So search up from this directory.
        current_dir = current_path

    # Walk up from current_dir to root_dir
    while True:
        agentignore_path = current_dir / '.agentignore'
        if agentignore_path.is_file():
            agentignore_files.append(str(agentignore_path))

        if current_dir == root:
            break

        # Safety break for filesystem root or if we accidentally go above root_dir
        if current_dir.parent == current_dir or (root not in current_dir.parents and current_dir != root):
             break

        current_dir = current_dir.parent

    # Rules from root apply first, so reverse the list found going upwards
    agentignore_files.reverse()
    return agentignore_files

def _load_rules_for_path(target_path, root_dir):
    """Loads and combines rules from all relevant .agentignore files up to target_path's directory."""
    agentignore_files = _find_agentignore_files_in_path(target_path, root_dir)
    all_rules = []
    for filepath in agentignore_files:
        all_rules.extend(_parse_agentignore_file(filepath))
    return all_rules

def _matches_rule(target_path_relative_to_origin_str, rule, is_target_dir):
    """
    Checks if a relative path string matches a rule.

    Uses pathlib.PurePath.match with adjustments for anchored and directory-only rules.
    Note: This is a simplified implementation of gitignore matching, particularly around
    directory-only rules and complex non-anchored patterns spanning directories.
    """
    pattern = rule['pattern']
    is_dir_only_rule = rule['is_dir_only'] # True if pattern ended in '/'
    is_anchored_rule = rule['is_anchored']

    # If rule is directory-only, it only applies if the target is a directory.
    # This simplifies gitignore's `dir/` behavior where it also matches contents.
    # Here, `dir/` pattern matches directory `dir` if `is_target_dir` is True AND pattern matches.
    # It does NOT match files inside `dir` with just the `dir/` pattern itself.
    # Matching files inside `dir` requires patterns like `dir/*` or `dir/**/*.log`.
    if is_dir_only_rule and not is_target_dir:
         return False

    # Handle the special case of the root directory '.' relative path.
    # This happens when evaluating the origin directory itself.
    if target_path_relative_to_origin_str == '.' or target_path_relative_to_origin_str == '': # pathlib can return '' for '.'
         # An anchored pattern '/' (represented as '' here) or non-anchored '.' matches the origin dir itself.
         # Also, an anchored pattern that is the directory name itself should match? No, .agentignore is *inside* the dir.
         # A pattern like '.' or '' only matches the origin dir itself if anchored or if pattern is '.'
         if (is_anchored_rule and pattern == '') or (not is_anchored_rule and pattern == '.'):
              return True
         return False # Other patterns don't match the origin dir itself

    # Standard matching using pathlib.PurePath.match
    # Adjust path and pattern strings based on anchoring for pathlib.match
    path_to_match_str = target_path_relative_to_origin_str
    pattern_to_match_str = pattern

    if is_anchored_rule:
        # For anchored rules, prepend '/' to both path and pattern for match simulation.
        # pathlib.PurePath('/a/b/c').match('/a/b/*') works for simulating start-anchored matches.
        path_to_match_str = '/' + path_to_match_str
        pattern_to_match_str = '/' + pattern_to_match_str

    # Perform the match using pathlib.PurePath.match (requires Python 3.8+) or equivalent logic.
    # Acknowledge potential minor differences from full gitignore spec, especially for complex ** usage with anchoring
    # and non-anchored patterns that should match anywhere (Path.match matches against the whole string).
    try:
         # Use PurePath for matching as target_path_relative_to_origin_str might not exist on disk.
         # This match method handles *, ?, [], and **.
         # Note: PurePath.match is available from Python 3.8. If using older Python,
         # this would need replacement with a custom globstar matcher or fnmatch components.
         return pathlib.PurePath(path_to_match_str).match(pattern_to_match_str)
    except Exception as e:
         # Catching potential errors during pattern matching (e.g. invalid glob syntax).
         print(f"Warning: Error matching pattern '{pattern_to_match_str}' against path '{path_to_match_str}': {e}. Skipping rule.")
         return False


# --- Main evaluation function ---

def evaluate_path(target_path, root_dir):
    """
    Evaluates if a target file or directory should be included based on .agentignore rules
    from root_dir up to the target_path's directory.

    Args:
        target_path: The absolute path to the file or directory being evaluated.
        root_dir: The absolute path to the root directory of the traversal.

    Returns:
        True if the path should be included, False otherwise.
    """
    target_path_obj = pathlib.Path(target_path).resolve()
    root_dir_obj = pathlib.Path(root_dir).resolve()

    # A path outside the root_dir should not be included
    try:
        target_path_obj.relative_to(root_dir_obj)
    except ValueError:
        # target_path is not within root_dir
        return False

    # Determine if target_path is a directory (needed for _matches_rule)
    # Note: This requires filesystem access. If simulating traversal without disk,
    # this boolean would need to be passed in.
    is_target_dir = target_path_obj.is_dir()

    # Load combined rules from root_dir up to the target_path's directory.
    # This includes the .agentignore file *in* target_path if target_path is a directory.
    # The rules in a directory's .agentignore apply to items *within* it, but the presence
    # of the .agentignore file itself is also determined by rules from *its* parent.
    # However, the primary rule application here is for the target_path itself against
    # rules from its ancestors (and potentially its own .agentignore if it's a dir).
    # Let's refine rule loading: load rules from root_dir up to the target_path's *parent* directory
    # when evaluating target_path itself. Rules *in* target_path/.agentignore (if it's a dir)
    # apply to its *children*, not target_path itself.

    if target_path_obj == root_dir_obj:
        # If evaluating the root directory itself, load rules from root_dir/.agentignore
        rules_apply_up_to_dir = root_dir_obj
    else:
         # If evaluating anything else, load rules up to its parent directory.
         rules_apply_up_to_dir = target_path_obj.parent


    combined_rules = _load_rules_for_path(rules_apply_up_to_dir, root_dir)

    # Default is to include
    included = True

    # Apply rules in order from root downwards. Last matching rule wins.
    for rule in combined_rules:
        # Calculate path relative to the rule's origin directory
        try:
            # Using Path object for relative_to as it handles cases like a == b -> '.'
            relative_path_obj = target_path_obj.relative_to(rule['origin_dir'])
            relative_path_str = str(relative_path_obj)
        except ValueError:
             # target_path is not a descendant of rule['origin_dir']. This should not
             # happen with the corrected _find_agentignore_files_in_path logic.
             print(f"Error calculating relative path: {target_path_obj} relative to {rule['origin_dir']}. Skipping rule.")
             continue # Skip rule


        if _matches_rule(relative_path_str, rule, is_target_dir):
            if rule['type'] == 'exclude':
                included = False
            elif rule['type'] == 'include':
                included = True # Inclusion rules override exclusion rules

    return included

# Note: The logic for skipping excluded directories based on a parent rule
# needs to be handled by the calling code that performs the directory traversal (e.g., in python_cli.py).
# This module's `evaluate_path` function determines the fate of a *single* path passed to it,
# based on rules from its ancestors. If a directory is excluded by a parent rule, the traversal
# logic should ideally not call `evaluate_path` for its contents.
