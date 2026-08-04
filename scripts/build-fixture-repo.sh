#!/usr/bin/env bash
# Build the ticket-08 fixture repo: a small Java/Maven project with three
# deliberately-broken branches (class 1/2/3 failures) + a spec directory.
#
# main            — healthy (tests green)
# class1-failing-test — CalculatorTest asserts add(2,3)==4 (wrong; real=5)
# class2-stale-test   — Calculator.add changed to multiply; test still asserts sum
# class3-missing-test — spec says add(2,3)==5 but no test covers it
#
# Usage: bash scripts/build-fixture-repo.sh
# Idempotent: re-runs reset the repo to a clean state.

set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "$0")/.." && pwd)/fixtures/repo"
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR/src/main/java/com/example"
mkdir -p "$FIXTURE_DIR/src/test/java/com/example"
mkdir -p "$FIXTURE_DIR/docs/spec"

cd "$FIXTURE_DIR"
git init --quiet
git config user.email "fixture@example.com"
git config user.name "fixture bot"

# --- pom.xml (single-module Maven project) ---
cat >pom.xml <<'EOF'
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>calculator</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
EOF

# --- Calculator (production code) ---
cat >src/main/java/com/example/Calculator.java <<'EOF'
package com.example;

/** A tiny calculator — the fixture's production surface. */
public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }
}
EOF

# --- CalculatorTest (healthy on main) ---
cat >src/test/java/com/example/CalculatorTest.java <<'EOF'
package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class CalculatorTest {
    @Test
    void addReturnsSum() {
        assertEquals(5, new Calculator().add(2, 3));
    }
}
EOF

# --- Spec (the contract the bot reads for class 3) ---
cat >docs/spec/calculator.md <<'EOF'
# Calculator API

`add(a, b)` returns the sum of `a` and `b`.

- `add(2, 3)` returns `5`
- `add(-1, 1)` returns `0`
- `add(0, 0)` returns `0`
EOF

git add -A
git commit --quiet -m "chore: fixture baseline (healthy)"

# --- class 1: failing test (assertion wrong) ---
git checkout --quiet -b class1-failing-test
cat >src/test/java/com/example/CalculatorTest.java <<'EOF'
package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;

class CalculatorTest {
    @Test
    void addReturnsSum() {
        // BUG: asserts 4, but add(2,3) == 5. Class 1 (test bug).
        assertEquals(4, new Calculator().add(2, 3));
    }
}
EOF
git add -A
git commit --quiet -m "feat: class1 failing test (assertion wrong)"

# --- class 2: stale test (production changed, test not updated) ---
git checkout --quiet master
git checkout --quiet -b class2-stale-test
cat >src/main/java/com/example/Calculator.java <<'EOF'
package com.example;

/** A tiny calculator — the fixture's production surface. */
public class Calculator {
    public int add(int a, int b) {
        // CHANGED: now returns the product (production behavior changed).
        return a * b;
    }
}
EOF
git add -A
git commit --quiet -m "feat: class2 production change (add -> multiply)"

# --- class 3: missing test (spec says behavior, no test covers it) ---
git checkout --quiet master
git checkout --quiet -b class3-missing-test
cat >docs/spec/calculator.md <<'EOF'
# Calculator API

`add(a, b)` returns the sum of `a` and `b`.

- `add(2, 3)` returns `5`
- `add(-1, 1)` returns `0`
- `add(0, 0)` returns `0`
- `add(10, 20)` returns `30`   <!-- NEW: spec requires this, no test covers it -->
EOF
git add -A
git commit --quiet -m "feat: class3 spec addition (no test yet)"

git checkout --quiet master
echo "fixture repo built at $FIXTURE_DIR"
git log --oneline --all | head -10
