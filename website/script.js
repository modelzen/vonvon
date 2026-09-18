const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

const revealElements = [...document.querySelectorAll(".reveal")];

revealElements.forEach((element, index) => {
  element.style.setProperty("--delay", `${Math.min(index * 70, 420)}ms`);
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.18,
    rootMargin: "0px 0px -8% 0px",
  }
);

revealElements.forEach((element) => {
  revealObserver.observe(element);
});

const dockDemo = document.querySelector("[data-dock-demo]");

if (dockDemo) {
  const stage = dockDemo.querySelector(".dock-stage");
  const fakeWindow = dockDemo.querySelector(".fake-feishu-window");
  const blob = dockDemo.querySelector(".dock-vonvon");
  const blobImage = dockDemo.querySelector("[data-dock-blob-image]");
  const label = dockDemo.querySelector("[data-dock-label]");
  const replayButton = dockDemo.querySelector("[data-dock-replay]");
  const steps = [...dockDemo.querySelectorAll("[data-dock-step]")];

  const stateMeta = {
    floating: { label: "Floating", order: 0, src: "assets/cat/floating.png" },
    snapping: { label: "Snapping", order: 1, src: "assets/cat/snapping.png" },
    "docked-expanded": {
      label: "Docked Expanded",
      order: 2,
      src: "assets/cat/docked-expanded.png",
    },
    "docked-collapsed": {
      label: "Docked Collapsed",
      order: 3,
      src: "assets/cat/docked-collapsed.png",
    },
    detaching: { label: "Detaching", order: 4, src: "assets/cat/transitions/detach-01.png" },
  };

  const detachFrames = [
    "assets/cat/transitions/detach-01.png",
    "assets/cat/transitions/detach-02.png",
    "assets/cat/transitions/detach-03.png",
    "assets/cat/transitions/detach-04.png",
  ];

  let currentState = "floating";
  let blobX = 0;
  let blobY = 0;
  let pointerId = null;
  let dragging = false;
  let hasMoved = false;
  let startedFromDocked = false;
  let startPointerX = 0;
  let startPointerY = 0;
  let startBlobX = 0;
  let startBlobY = 0;
  let animationToken = 0;

  const dragThreshold = 8;

  const blobSizeForState = (state) => {
    switch (state) {
      case "snapping":
        return { width: 88, height: 102 };
      case "docked-expanded":
        return { width: 104, height: 88 };
      case "docked-collapsed":
        return { width: 96, height: 96 };
      case "detaching":
        return { width: 102, height: 86 };
      default:
        return { width: 92, height: 92 };
    }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const setBlobPosition = (x, y) => {
    blobX = x;
    blobY = y;
    dockDemo.style.setProperty("--blob-x", `${x}px`);
    dockDemo.style.setProperty("--blob-y", `${y}px`);
  };

  const updateStepStates = () => {
    const currentOrder = stateMeta[currentState].order;
    steps.forEach((step) => {
      const stepKey = step.getAttribute("data-dock-step");
      const stepOrder = stateMeta[stepKey]?.order ?? -1;
      step.classList.toggle("is-active", stepKey === currentState);
      step.classList.toggle("is-complete", stepOrder < currentOrder);
    });
  };

  const setState = (nextState) => {
    currentState = nextState;
    dockDemo.dataset.state = nextState;
    if (label) {
      label.textContent = stateMeta[nextState].label;
    }
    if (blobImage && stateMeta[nextState].src) {
      blobImage.src = stateMeta[nextState].src;
    }
    updateStepStates();
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const getMetrics = () => {
    const stageRect = stage.getBoundingClientRect();
    const windowRect = fakeWindow.getBoundingClientRect();
    const dockedSize = blobSizeForState("docked-expanded");
    return {
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
      winLeft: windowRect.left - stageRect.left,
      winTop: windowRect.top - stageRect.top,
      winRight: windowRect.right - stageRect.left,
      winBottom: windowRect.bottom - stageRect.top,
      floatingX: stage.clientWidth * 0.06,
      floatingY: stage.clientHeight * 0.74,
      dockedX: windowRect.right - stageRect.left - dockedSize.width * 0.54,
      dockedY: windowRect.top - stageRect.top - dockedSize.height * 0.2,
    };
  };

  const detectSnap = (x, y) => {
    const metrics = getMetrics();
    const size = blobSizeForState("snapping");
    const centerX = x + size.width / 2;
    const centerY = y + size.height / 2;
    const distanceToEdge = Math.abs(centerX - metrics.winRight);
    const withinVerticalBounds =
      centerY >= metrics.winTop + 16 && centerY <= metrics.winBottom - 16;
    return withinVerticalBounds && distanceToEdge < Math.max(60, metrics.stageWidth * 0.06);
  };

  const resetDockDemo = () => {
    animationToken += 1;
    const metrics = getMetrics();
    const size = blobSizeForState("floating");
    setBlobPosition(
      clamp(metrics.floatingX, 12, metrics.stageWidth - size.width - 12),
      clamp(metrics.floatingY, 16, metrics.stageHeight - size.height - 14)
    );
    setState("floating");
  };

  const snapToDock = (expanded = true) => {
    animationToken += 1;
    const metrics = getMetrics();
    const state = expanded ? "docked-expanded" : "docked-collapsed";
    const size = blobSizeForState(state);
    setBlobPosition(
      clamp(metrics.dockedX, 0, metrics.stageWidth - size.width),
      clamp(metrics.dockedY, 0, metrics.stageHeight - size.height)
    );
    setState(state);
  };

  const releaseDock = () => {
    animationToken += 1;
    setState("floating");
    const size = blobSizeForState("floating");
    setBlobPosition(
      clamp(blobX, 0, stage.clientWidth - size.width),
      clamp(blobY, 0, stage.clientHeight - size.height)
    );
  };

  const playDetachTransition = async () => {
    const token = ++animationToken;
    setState("detaching");

    if (blobImage) {
      for (const frame of detachFrames) {
        if (token !== animationToken) return;
        blobImage.src = frame;
        await sleep(70);
      }
    } else {
      await sleep(280);
    }

    if (token !== animationToken) return;
    setState("floating");
    const size = blobSizeForState("floating");
    setBlobPosition(
      clamp(blobX, 0, stage.clientWidth - size.width),
      clamp(blobY, 0, stage.clientHeight - size.height)
    );
  };

  const onPointerMove = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;

    const activeState = startedFromDocked ? "detaching" : currentState;
    const size = blobSizeForState(activeState);
    const nextX = clamp(
      startBlobX + (event.clientX - startPointerX),
      0,
      stage.clientWidth - size.width
    );
    const nextY = clamp(
      startBlobY + (event.clientY - startPointerY),
      0,
      stage.clientHeight - size.height
    );

    if (
      !hasMoved &&
      Math.hypot(event.clientX - startPointerX, event.clientY - startPointerY) >
        dragThreshold
    ) {
      hasMoved = true;
    }

    if (hasMoved) {
      if (detectSnap(nextX, nextY)) {
        setState("snapping");
      } else if (startedFromDocked) {
        setState("detaching");
      } else {
        setState("floating");
      }
    }

    setBlobPosition(nextX, nextY);
  };

  const endDrag = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    blob.classList.remove("is-dragging");

    if (!hasMoved && startedFromDocked) {
      if (currentState === "docked-expanded") {
        snapToDock(false);
      } else {
        snapToDock(true);
      }
      return;
    }

    if (detectSnap(blobX, blobY)) {
      snapToDock(true);
      return;
    }

    if (startedFromDocked) {
      void playDetachTransition();
      return;
    }

    releaseDock();
  };

  blob.addEventListener("pointerdown", (event) => {
    pointerId = event.pointerId;
    dragging = true;
    hasMoved = false;
    startedFromDocked =
      currentState === "docked-expanded" || currentState === "docked-collapsed";
    startPointerX = event.clientX;
    startPointerY = event.clientY;
    startBlobX = blobX;
    startBlobY = blobY;
    blob.classList.add("is-dragging");
    blob.setPointerCapture(event.pointerId);
  });

  blob.addEventListener("pointermove", onPointerMove);
  blob.addEventListener("pointerup", endDrag);
  blob.addEventListener("pointercancel", endDrag);

  replayButton?.addEventListener("click", resetDockDemo);

  window.addEventListener("resize", () => {
    if (currentState === "docked-expanded") {
      snapToDock(true);
      return;
    }
    if (currentState === "docked-collapsed") {
      snapToDock(false);
      return;
    }
    releaseDock();
  });

  if (prefersReducedMotion) {
    resetDockDemo();
  } else {
    resetDockDemo();
  }
}
