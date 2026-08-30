import { defineRule } from "@oxlint/plugins";

const loops = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

function enclosingLoop(node: { parent?: unknown }): boolean {
  let current = node.parent;
  while (current && typeof current === "object" && "type" in current) {
    if (loops.has(String(current.type))) return true;
    current = "parent" in current ? current.parent : undefined;
  }
  return false;
}

export const noQuadraticBufferConcatRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow loop-carried Buffer.concat accumulators that copy all prior bytes on every iteration.",
    },
    messages: {
      quadratic:
        "Collect bounded chunks and concatenate once; this loop-carried Buffer.concat grows quadratically.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.object.type !== "Identifier" ||
          node.callee.object.name !== "Buffer" ||
          node.callee.computed ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "concat" ||
          node.arguments[0]?.type !== "ArrayExpression" ||
          !enclosingLoop(node)
        )
          return;
        let expression = node;
        let parent = expression.parent;
        while (
          parent?.type === "ConditionalExpression" &&
          (parent.consequent === expression || parent.alternate === expression)
        ) {
          expression = parent;
          parent = expression.parent;
        }
        if (
          parent?.type !== "AssignmentExpression" ||
          parent.operator !== "=" ||
          parent.right !== expression ||
          parent.left.type !== "Identifier"
        )
          return;
        const target = parent.left.name;
        const carriesTarget = node.arguments[0].elements.some(
          (element) => element?.type === "Identifier" && element.name === target
        );
        if (carriesTarget) context.report({ node, messageId: "quadratic" });
      },
    };
  },
});
