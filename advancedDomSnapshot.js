export function buildAdvancedDomSnapshot(args = {}) {
  const {
    doHighlightElements = false,
    focusHighlightIndex = -1,
    viewportExpansion = 0,
    debugMode = false,
  } = args;

  return (function () {
    // Initialize the variables we'll return
    let highlightIndex = 0;
    const DOM_HASH_MAP = {};
    const ID = { current: 0 };
    let rootId = null;
    let PERF_METRICS = null;
    
    if (debugMode) {
      PERF_METRICS = {
        nodeMetrics: {
          totalNodes: 0,
          processedNodes: 0,
          skippedNodes: 0,
        }
      };
    }

    // Simple function to get element attributes
    function getElementAttributes(element) {
      const attributes = {};
      if (element.getAttributeNames) {
        for (const name of element.getAttributeNames()) {
          attributes[name] = element.getAttribute(name);
        }
      }
      return attributes;
    }

    // Simple function to check if element is visible
    function isElementVisible(element) {
      if (!element) return false;
      
      const style = window.getComputedStyle(element);
      return (
        element.offsetWidth > 0 &&
        element.offsetHeight > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0"
      );
    }

    // Simple function to check if element is interactive
    function isInteractiveElement(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      
      const interactiveElements = new Set([
        "a", "button", "input", "select", "textarea", "details", "summary"
      ]);
      
      const tagName = element.tagName.toLowerCase();
      
      // Basic check for common interactive elements
      if (interactiveElements.has(tagName)) return true;
      
      // Check for role attributes
      const role = element.getAttribute("role");
      if (role === "button" || role === "link" || role === "checkbox" || role === "menuitem") return true;
      
      // Check for event handlers
      if (element.onclick || element.getAttribute("onclick")) return true;
      
      // Check for tabindex
      const tabIndex = element.getAttribute("tabindex");
      if (tabIndex !== null && tabIndex !== "-1") return true;
      
      return false;
    }

    // Simple function to build DOM tree
    function buildDomTree(node, depth = 0) {
      if (!node) return null;
      
      // Skip our own highlight container if it exists
      if (node.id === "playwright-highlight-container") return null;
      
      // Skip non-element nodes except text nodes with content
      if (node.nodeType !== Node.ELEMENT_NODE) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          const id = `text_${ID.current++}`;
          DOM_HASH_MAP[id] = {
            type: "TEXT_NODE",
            text: node.textContent.trim(),
            parentElement: node.parentElement ? node.parentElement.tagName.toLowerCase() : null
          };
          return id;
        }
        return null;
      }
      
      // Process element node
      const tagName = node.tagName.toLowerCase();
      
      // Skip some elements we don't care about
      if (tagName === "script" || tagName === "style" || tagName === "noscript") return null;
      
      const nodeData = {
        tagName,
        attributes: getElementAttributes(node),
        children: [],
        isVisible: isElementVisible(node)
      };
      
      // Only check interactivity for visible elements
      if (nodeData.isVisible) {
        nodeData.isInteractive = isInteractiveElement(node);
        
        // Add highlight index for interactive elements
        if (nodeData.isInteractive) {
          nodeData.highlightIndex = highlightIndex++;
          
          // Highlight the element if requested
          if (doHighlightElements) {
            // Simplified highlighting logic
            if (focusHighlightIndex < 0 || focusHighlightIndex === nodeData.highlightIndex) {
              // In a real implementation, we'd add visual highlights here
              console.log(`Highlighting element: ${tagName}#${node.id || ''}`);
            }
          }
        }
      }
      
      // Process children, but limit depth to avoid stack overflow
      if (depth < 20) {
        for (const child of node.childNodes) {
          const childId = buildDomTree(child, depth + 1);
          if (childId) nodeData.children.push(childId);
        }
      }
      
      // Store in map and return ID
      const id = `element_${ID.current++}`;
      DOM_HASH_MAP[id] = nodeData;
      
      // If this is the body element, set as root
      if (tagName === "body") {
        rootId = id;
      }
      
      return id;
    }

    // Actually build the DOM tree starting from body
    if (document.body) {
      rootId = buildDomTree(document.body);
    } else {
      // Fallback if body isn't available
      rootId = "root_0";
      DOM_HASH_MAP[rootId] = { error: "No document.body available" };
    }

    // Return the result
    return debugMode
      ? { rootId, map: DOM_HASH_MAP, perfMetrics: PERF_METRICS }
      : { rootId, map: DOM_HASH_MAP };
  })();
} 