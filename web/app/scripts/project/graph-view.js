// Graph visualization. Generates the SVG contents.
'use strict';

angular.module('biggraph').directive('graphView', function(util, $compile, $timeout) {
  /* global SVG_UTIL, COMMON_UTIL, FORCE_LAYOUT, tinycolor */
  const svg = SVG_UTIL;
  const common = COMMON_UTIL;
  const directive = {
    restrict: 'E',
    templateUrl: 'scripts/project/graph-view.html',
    scope: { graph: '=', menu: '=', width: '=', height: '=' },
    replace: true,
    link: function(scope, element) {
      element = angular.element(element);
      scope.gv = new GraphView(scope, element);
      scope.updateGraph = function() {
        if (scope.graph.view === undefined ||
          !scope.graph.view.$resolved ||
          !scope.gv.iconsLoaded()) {
          scope.gv.loading();
        } else if (scope.graph.view.$error) {
          scope.gv.error(scope.graph.view);
        } else {
          scope.gv.update(scope.graph.view, scope.menu);
        }
      };
      scope.$watch('graph.view', scope.updateGraph);
      scope.$watch('graph.view.$resolved', scope.updateGraph);
      // An attribute change can happen without a graph data change. Watch them separately.
      // (When switching from "color" to "slider", for example.)
      util.deepWatch(scope, 'graph.left.vertexAttrs', scope.updateGraph);
      util.deepWatch(scope, 'graph.right.vertexAttrs', scope.updateGraph);
      util.deepWatch(scope, 'graph.left.edgeAttrs', scope.updateGraph);
      util.deepWatch(scope, 'graph.right.edgeAttrs', scope.updateGraph);
      scope.$on('$destroy', function() { scope.gv.clear(); });
      handleResizeEvents(scope);
    },
  };

  function handleResizeEvents(scope) {
    let timer;
    function update() {
      // Only update 100ms after the last resize to reduce
      // excessive redrawing.
      $timeout.cancel(timer);
      timer = $timeout(scope.updateGraph, 100);
    }

    scope.$watchGroup(['width', 'height'], update);
    scope.$on('$destroy', function() {
      $timeout.cancel(timer);
    });
  }

  function Offsetter(xOff, yOff, zoom, thickness, menu, xMin, xMax, side) {
    this.xOff = xOff;
    this.yOff = yOff;
    this.zoom = zoom;  // Zoom for positions.
    this.thickness = thickness;  // Zoom for radius/width.
    this.menu = menu;
    this.elements = [];
    this.xMin = xMin;
    this.xMax = xMax;
    this.side = side;
  }
  Offsetter.prototype.rule = function(element) {
    this.elements.push(element);
    const that = this;
    element.offsetter = this;
    element.screenX = function() {
      return element.x * that.zoom + that.xOff;
    };
    element.screenY = function() {
      return element.y * that.zoom + that.yOff;
    };
    element.activateMenu = function(menuData) {
      that.menu.x = element.screenX();
      that.menu.y = element.screenY();
      that.menu.data = menuData;
      that.menu.enabled = true;
    };
    element.reDraw();
  };
  Offsetter.prototype.panTo = function(x, y) {
    this.xOff = x;
    this.yOff = y;
    this.reDraw();
  };
  Offsetter.prototype.reDraw = function() {
    if (!this.drawing) {
      this.drawing = true;
      const that = this;
      // Call the actual drawing asynchronously.
      $timeout(function() {
        for (let i = 0; i < that.elements.length; ++i) {
          that.elements[i].reDraw();
        }
        that.drawing = false;
      });
    }
  };
  Offsetter.prototype.inherit = function() {
    const offsetter = new Offsetter(
        this.xOff, this.yOff, this.zoom, this.thickness, this.menu,
        this.xMin, this.xMax, this.side);
    offsetter.inherited = true;
    return offsetter;
  };

  function GraphView(scope, element) {
    this.scope = scope;
    this.unregistration = [];  // Cleanup functions to be called before building a new graph.
    this.rootElement = element;
    this.svg = element.find('svg.graph-view');
    this.svg.append([
      svg.marker('arrow'),
      svg.marker('arrow-highlight-in'),
      svg.marker('arrow-highlight-out'),
    ]);
    this.root = svg.create('g', {'class': 'root'});
    this.svg.append(this.root);
    // Top-level mouse/touch listeners.
    this.svgMouseDownListeners = [];
    const that = this;
    this.svg.on('mousedown touchstart', function(e) {
      for (let i = 0; i < that.svgMouseDownListeners.length; ++i) {
        that.svgMouseDownListeners[i](e);
      }
    });
    this.svgMouseWheelListeners = [];
    this.svg.on('wheel', function(e) {
      for (let i = 0; i < that.svgMouseWheelListeners.length; ++i) {
        that.svgMouseWheelListeners[i](e);
      }
    });
    this.svgDoubleClickListeners = [];
    function doubleClick(e) {
      for (let i = 0; i < that.svgDoubleClickListeners.length; ++i) {
        that.svgDoubleClickListeners[i](e);
      }
    }
    this.svg.on('dblclick', doubleClick);
    // Handle right double-clicks too. This disables the default context
    // menu, which is actually a good thing too.
    let lastRightClickTime = 0;
    this.svg.on('contextmenu', function(e) {
      e.preventDefault();
      let now = Date.now();
      if (now - lastRightClickTime < 300) {  // milliseconds
        doubleClick(e);
        now = 0;
      }
      lastRightClickTime = now;
    });
    this.renderers = [];  // 3D renderers.
  }

  GraphView.prototype.iconsLoaded = function() {
    return this.hasIcon('circle');
  };

  // Returns a reference to the icon inside #svg-icons.
  GraphView.prototype.getOriginalIcon = function(name) {
    return this.rootElement.find('#svg-icons #' + name.toLowerCase());
  };

  GraphView.prototype.hasIcon = function(name) {
    if (!name) { return false; }
    const icon = this.getOriginalIcon(name);
    return icon.length !== 0;
  };

  // Creates a scaled clone of the icon inside #svg-icons.
  GraphView.prototype.getIcon = function(name) {
    const icon = this.getOriginalIcon(name);
    const circle = this.getOriginalIcon('circle');
    const cbb = circle[0].getBBox();
    const bb = icon[0].getBBox();
    const clone = icon.clone();
    // Take the scaling factor from the circle icon.
    clone.scale = 2 / Math.max(cbb.width, cbb.height);
    clone.center = {
      x: bb.x + bb.width / 2,
      y: bb.y + bb.height / 2,
    };
    return clone;
  };

  GraphView.prototype.clear = function() {
    svg.removeClass(this.svg, 'loading');
    svg.removeClass(this.svg, 'fade-non-opaque');
    this.root.empty();
    for (let i = 0; i < this.unregistration.length; ++i) {
      this.unregistration[i]();
    }
    this.unregistration = [];
    this.svgMouseDownListeners = [];
    this.svgMouseWheelListeners = [];
    this.svgDoubleClickListeners = [];
    for (let i = 0; i < this.renderers.length; ++i) {
      this.renderers[i].scope().$destroy();
      this.renderers[i].remove();
    }
    this.renderers = [];
  };

  GraphView.prototype.loading = function() {
    svg.addClass(this.svg, 'loading');
  };

  GraphView.prototype.error = function(view) {
    this.clear();
    const x = this.svg.width() / 2, y = this.svg.height() / 2;
    const text = svg.create('text', {'class': 'clicky error', x: x, y: y, 'text-anchor': 'middle'});
    text.text('Failed to generate visualization. Click to report problem.');
    text.click(function() {
      util.reportRequestError(view, 'Graph visualization failed.');
    });
    this.root.append(text);
    const errorMessage = svg.create('text',
      {'class': 'error-message', x: x, y: y + 30, 'text-anchor': 'middle'});
    errorMessage.text(view.$error);
    this.root.append(errorMessage);
  };

  const graphToSVGRatio = 0.8;  // Leave some margin.
  const UNCOLORED = '#39bcf3';  // Brand color.

  GraphView.prototype.addGroup = function(className, clipper) {
    let group;
    if (clipper !== undefined) {
      this.root.prepend(clipper.dom);
      group = svg.create('g', { 'class': className, 'clip-path': clipper.url });
    } else {
      group = svg.create('g', { 'class': className });
    }
    this.root.append(group);
    return group;
  };

  GraphView.prototype.addSideSeparators = function(numVisibleSides) {
    if (numVisibleSides <= 1) {
      return;
    }
    const separatorGroup = svg.create('g', {'class': 'side-separators'});
    this.root.append(separatorGroup);
    const sideWidth = this.svg.width() / numVisibleSides;
    for (let i = 0; i < numVisibleSides - 1; ++i) {
      const separatorLine = svg.create('line', {
        x1: sideWidth * (i + 1),
        y1: 0,
        x2: sideWidth * (i + 1),
        y2: this.svg.height(),
        'class': 'side-separator-line',
      });
      separatorGroup.append(separatorLine);
    }
  };

  GraphView.prototype.createClippers = function(halfColumnWidth, numVisibleSides) {
    const clippers = [];
    for (let i = 0; i < numVisibleSides; ++i) {
      const isLeftMost = i === 0;
      const isRightMost = i === (numVisibleSides - 1);
      const separatorWidthHalf = 1;
      const leftOffset = isLeftMost ? 0 : separatorWidthHalf;
      const rightOffset = isRightMost ? 0 : separatorWidthHalf;
      const clipper = new Clipper({
        x: (i * 2) * halfColumnWidth + leftOffset,
        y: 0,
        width: halfColumnWidth * 2 - leftOffset - rightOffset,
        height: 30000,
      });
      this.root.prepend(clipper.dom);
      clippers.push(clipper);
    }
    return clippers;
  };

  GraphView.prototype.update = function(data, menu) {
    this.clear();
    const zoom = this.svg.height() * graphToSVGRatio;
    const sides = [this.scope.graph.left, this.scope.graph.right];
    const visibleSides = sides.filter(function(s) { return s && s.graphMode; });
    const halfColumnWidth = this.svg.width() / visibleSides.length / 2;
    this.edgeGroups = [];
    this.vertexGroups = [];
    this.addSideSeparators(visibleSides.length);
    const clippers = this.createClippers(halfColumnWidth, visibleSides.length);
    // The order of adding the groups is important. Whatever comes later, will overlay
    // things defined earlier. We want edges to be overlaid by vertices.
    this.crossEdgeGroup = this.addGroup('edges');
    for (let i = 0; i < visibleSides.length; ++i) {
      this.edgeGroups.push(this.addGroup('edges', clippers[i]));
    }
    for (let i = 0; i < visibleSides.length; ++i) {
      this.vertexGroups.push(this.addGroup('nodes side' + i, clippers[i]));
    }
    this.legend = svg.create('g', {'class': 'legend'});
    this.root.append(this.legend);
    const oldVertices = this.vertices || new Vertices(this);
    this.vertices = [];  // Sparse, indexed by side. Everything else is indexed by visible side.
    const sideIndices = [];  // Maps from visible index to side index.
    let vsi = 0;
    let vs;
    for (let i = 0; i < sides.length; ++i) {
      if (sides[i] && sides[i].graphMode) {
        const xMin = (vsi * 2) * halfColumnWidth;
        const xOff = (vsi * 2 + 1) * halfColumnWidth;
        const xMax = (vsi * 2 + 2) * halfColumnWidth;
        const yOff = this.svg.height() / 2;
        const dataVs = data.vertexSets[vsi];
        if (sides[i].display !== '3d') {
          let offsetter;
          if (oldVertices[i] && oldVertices[i].mode === dataVs.mode) {
            offsetter = oldVertices[i].offsetter.inherit();
            if (oldVertices[i].halfColumnWidth !== halfColumnWidth) {
              offsetter.xOff = xOff;
              offsetter.xMin = xMin;
              offsetter.xMax = xMax;
            }
          } else {
            offsetter = new Offsetter(xOff, yOff, zoom, 300, menu, xMin, xMax, i);
          }
          if (dataVs.mode === 'sampled') {
            vs = this.addSampledVertices(dataVs, offsetter, sides[i], this.vertexGroups[vsi], i);
          } else {
            vs = this.addBucketedVertices(dataVs, offsetter, sides[i], this.vertexGroups[vsi]);
          }
          vs.offsetter = offsetter;
          vs.xMin = xMin;
          vs.halfColumnWidth = halfColumnWidth;
          vs.clipper = clippers[vsi];
          this.vertices[i] = vs;
          this.sideMouseBindings(offsetter, xMin, xMax);
        }
        vsi += 1;
        sideIndices.push(i);
      }
    }
    let side;
    for (let i = 0; i < data.edgeBundles.length; ++i) {
      const e = data.edgeBundles[i];
      // Avoid an error with the Grunt test data, which has edges going to the other side
      // even if we only have one side.
      if (e.srcIdx >= visibleSides.length || e.dstIdx >= visibleSides.length) { continue; }
      side = undefined;
      let edgeGroup = this.crossEdgeGroup;
      if (e.srcIdx === e.dstIdx) {
        const idx = e.srcIdx;
        side = visibleSides[idx];
        edgeGroup = this.edgeGroups[idx];
        if (side.display === '3d') {
          const scope = this.scope.$new();
          scope.edges = e.edges;
          scope.layout3D = e.layout3D;
          scope.width = 2 * halfColumnWidth;
          scope.left = idx * 2 * halfColumnWidth;
          const r = $compile('<renderer></renderer>')(scope);
          this.svg.after(r);
          this.renderers.push(r);
          continue;
        }
        if (this.vertices[sideIndices[idx]].mode === 'sampled' && e.edges.length >= 5) {
          this.vertices[sideIndices[idx]].addLegendLine(e.edges.length + ' edges');
        }
      }
      const src = this.vertices[sideIndices[e.srcIdx]];
      const dst = this.vertices[sideIndices[e.dstIdx]];
      const edges = this.addEdges(e.edges, src, dst, side, edgeGroup);
      if (e.srcIdx === e.dstIdx) {
        src.edges = edges;
      }
    }
    for (let i = 0; i < this.vertices.length; ++i) {
      vs = this.vertices[i];
      if (vs && vs.mode === 'sampled') {
        const old = oldVertices[i];
        if (old && old.vertexSetId === vs.vertexSetId) {
          copyLayoutAndFreezeOld(old, vs);
        }
        this.initSampled(vs);
        unfreezeAll(vs);
      }
    }
  };

  function copyLayoutAndFreezeOld(from, to) {
    const fromById = {};
    for (let i = 0; i < from.vs.length; ++i) {
      fromById[from.vs[i].id] = from.vs[i];
    }
    for (let i = 0; i < to.vs.length; ++i) {
      const v = to.vs[i];
      const fv = fromById[v.id];
      if (fv) {
        v.x = fv.x;
        v.y = fv.y;
        // Copy frozen status, plus add one more freeze.
        v.frozen = fv.frozen + 1;
      }
    }
  }

  function unfreezeAll(vertices) {
    for (let i = 0; i < vertices.vs.length; ++i) {
      if (vertices.vs[i].frozen) {
        vertices.vs[i].frozen -= 1;
      }
    }
  }

  function mapByAttr(vs, attr, type) {
    return vs.filter(v => v.attrs[attr].defined).map(v => v.attrs[attr][type]);
  }

  function doubleColorMap(values) {
    const bounds = common.minmax(values);
    const colorMap = {};
    for (let i = 0; i < values.length; ++i) {
      const h = 300 + common.normalize(values[i], bounds) * 120;
      colorMap[values[i]] = 'hsl(' + h + ',50%,42%)';
    }
    return colorMap;
  }

  function stringColorMap(values) {
    const set = {};
    for (let i = 0; i < values.length; ++i) {
      set[values[i]] = 1;
    }
    const keys = Object.keys(set);
    keys.sort();  // This provides some degree of stability.
    const colorMap = {};
    for (let i = 0; i < keys.length; ++i) {
      const h = Math.floor(360 * i / keys.length);
      colorMap[keys[i]] = 'hsl(' + h + ',50%,42%)';
    }
    // Strings that are valid CSS color names will be used as they are.
    for (let i = 0; i < keys.length; ++i) {
      const tiny = tinycolor(keys[i]);
      if (tiny.isValid()) {
        colorMap[keys[i]] = tiny.toString();
      }
    }
    return colorMap;
  }

  // Vertices represents a set of vertices. The Vertex objects are in the "vs" array.
  // A wide range of metadata is also contained in this object, plus some methods.
  function Vertices(graphView) {
    this.gv = graphView;
    this.vs = [];
    this.iconMapping = {};
  }
  // Prepare a label-icon map for these labels, generate legend.
  Vertices.prototype.initIcons = function(attr, labels) {
    let neutrals = ['square', 'hexagon', 'pentagon', 'star', 'triangle', 'circle'];
    function dropNeutral(label) {
      const j = neutrals.indexOf(label);
      if (j !== -1) {
        neutrals.splice(j, 1);
      }
    }
    const mapping = {};
    const unassigned = [];
    this.addLegendLine('Icon: ' + attr);
    // Assign literals first.
    for (let i = 0; i < labels.length; ++i) {
      let label = labels[i];
      if (!mapping[label]) {
        if (label === undefined) {
          mapping[label] = 'circle';
          dropNeutral('circle');
          this.addLegendLine('circle: undefined', 10);
        } else if (this.gv.hasIcon(label) && label !== 'circle') {
          mapping[label] = label;
          dropNeutral(label);
        } else if (unassigned.indexOf(label) === -1) {
          unassigned.push(label);
        }
      }
    }
    // Assign neutrals.
    if (neutrals.length === 0) { neutrals = ['circle']; }
    if (unassigned.length <= neutrals.length) {
      for (let i = 0; i < unassigned.length; ++i) {
        mapping[unassigned[i]] = neutrals[i];
        this.addLegendLine(neutrals[i] + ': ' + unassigned[i], 10);
      }
    } else {
      const wildcard = neutrals.pop();
      for (let i = 0; i < neutrals.length; ++i) {
        mapping[unassigned[i]] = neutrals[i];
        this.addLegendLine(neutrals[i] + ': ' + unassigned[i], 10);
      }
      this.addLegendLine(wildcard + ': other', 10);
    }
    this.iconMapping = mapping;
  };

  Vertices.prototype.getIcon = function(label) {
    return this.gv.getIcon(this.iconMapping[label] || 'circle');
  };

  Vertices.prototype.addLegendLine = function(text, indent) {
    indent = indent || 0;
    const margin = 50;
    const xMargin = margin + indent;
    const x = this.leftOrRight === 'left' ? xMargin : this.gv.svg.width() - xMargin;
    const anchor = this.leftOrRight === 'left' ? 'start' : 'end';
    const i = this.legendNextLine || 0;
    this.legendNextLine = i + 1;
    const legendElement =
      svg.create('text', { 'class': 'legend', x: x, y: i * 22 + margin }).text(text);
    legendElement.attr('text-anchor', anchor);
    this.gv.legend.append(legendElement);
    return legendElement;
  };

  Vertices.prototype.addColorLegend = function(colorMap, title) {
    this.addLegendLine(title);
    for (let attr in colorMap) {
      const l = this.addLegendLine(attr || 'undefined', 10);
      l.attr('style', 'fill: ' + colorMap[attr] || UNCOLORED);
    }
  };

  Vertices.prototype.setupColorMap = function(
      siblings, colorMeta, legendTitle, colorKey) {
    let resultMap;
    if (colorMeta) {
      colorKey = (colorKey === undefined) ? colorMeta.id : colorKey;
      const fullLegendTitle = legendTitle + ': ' + colorMeta.title;
      if (colorMeta.typeName === 'Double') {
        const values = mapByAttr(siblings, colorKey, 'double');
        resultMap = doubleColorMap(values);
        const bounds = common.minmax(values);
        const legendMap = {};
        legendMap['min: ' + bounds.min] = resultMap[bounds.min];
        legendMap['max: ' + bounds.max] = resultMap[bounds.max];
        // only shows the min max values
        this.addColorLegend(legendMap, fullLegendTitle);
      } else if (colorMeta.typeName === 'String') {
        resultMap = stringColorMap(mapByAttr(siblings, colorKey, 'string'));
        this.addColorLegend(resultMap, fullLegendTitle);
      } else {
        /* eslint-disable no-console */
        console.error('The type of ' +
                      colorMeta + ' (' + colorMeta.typeName +
                      ') is not supported for color visualization!');
      }
    }
    return resultMap;
  };

  GraphView.prototype.addSampledVertices = function(data, offsetter, side, vertexGroup, sideIndex) {
    const vertices = new Vertices(this);
    vertices.side = side;
    vertices.mode = 'sampled';
    vertices.offsetter = offsetter;
    vertices.vertexSetId = side.vertexSet.id;
    vertices.leftOrRight = sideIndex === 0 ? 'left' : 'right';

    for (let attr in side.vertexAttrs) {
      if (side.vertexAttrs[attr] !== undefined) {
        // Capitalize.
        let attrLabel = attr.charAt(0).toUpperCase() + attr.slice(1);
        // UnCammelify.
        attrLabel = attrLabel.replace(/([A-Z])/g, ' $1');
        // We handle icon and color attributes separately.
        if (attrLabel.indexOf('Color') === -1 && attrLabel !== ' Icon') {
          vertices.addLegendLine(attrLabel + ': ' + side.vertexAttrs[attr].title);
        }
      }
    }

    const sizeAttr = (side.vertexAttrs.size) ? side.vertexAttrs.size.id : undefined;
    let sizeMax = 1;
    if (sizeAttr) {
      const vertexSizeBounds = common.minmax(mapByAttr(data.vertices, sizeAttr, 'double'));
      sizeMax = vertexSizeBounds.max;
    }

    const labelSizeAttr = (side.vertexAttrs.labelSize) ? side.vertexAttrs.labelSize.id : undefined;
    let labelSizeMax = 1;
    if (labelSizeAttr) {
      const labelSizeBounds = common.minmax(mapByAttr(data.vertices, labelSizeAttr, 'double'));
      labelSizeMax = labelSizeBounds.max;
    }

    const colorAttr = (side.vertexAttrs.color) ? side.vertexAttrs.color.id : undefined;
    const colorMap = vertices.setupColorMap(data.vertices, side.vertexAttrs.color, 'Vertex Color');

    const labelColorAttr = (side.vertexAttrs.labelColor) ? side.vertexAttrs.labelColor.id : undefined;
    const labelColorMap = vertices.setupColorMap(
      data.vertices, side.vertexAttrs.labelColor, 'Label Color');

    const opacityAttr = (side.vertexAttrs.opacity) ? side.vertexAttrs.opacity.id : undefined;
    let opacityMax = 1;
    if (opacityAttr) {
      const opacityBounds = common.minmax(mapByAttr(data.vertices, opacityAttr, 'double'));
      opacityMax = opacityBounds.max;
    }

    if (side.vertexAttrs.icon) {
      // Collect icon strings for icon assignment.
      const iconStrings = [];
      for (let i = 0; i < data.vertices.length; ++i) {
        let vertex = data.vertices[i];
        let icon = vertex.attrs[side.vertexAttrs.icon.id];
        if (icon.defined) {
          iconStrings.push(icon.string);
        } else {
          iconStrings.push(undefined);
        }
      }
      vertices.initIcons(side.vertexAttrs.icon.title, iconStrings);
    }

    for (let i = 0; i < data.vertices.length; ++i) {
      const vertex = data.vertices[i];

      let label;
      if (side.vertexAttrs.label) {
        label = vertex.attrs[side.vertexAttrs.label.id].string;
      }

      let size = 0.5;
      if (sizeAttr) {
        const s = vertex.attrs[sizeAttr].double;
        size = s > 0 ? s / sizeMax : 0;
      }

      let labelSize = 0.5;
      if (labelSizeAttr) {
        const l = vertex.attrs[labelSizeAttr].double;
        labelSize = l > 0 ? l / labelSizeMax : 0;
      }

      let color = UNCOLORED;
      if (colorAttr && vertex.attrs[colorAttr].defined) {
        // in case of doubles the keys are strings converted from the DynamicValue's double field
        // we can't just use the string field of the DynamicValue as 1.0 would turn to '1'
        color = (side.vertexAttrs.color.typeName === 'Double') ?
          colorMap[vertex.attrs[colorAttr].double] : colorMap[vertex.attrs[colorAttr].string];
      }

      let labelColor;
      if (labelColorAttr && vertex.attrs[labelColorAttr].defined) {
        // in case of doubles the keys are strings converted from the DynamicValue's double field
        // we can't just use the string field of the DynamicValue as 1.0 would turn to '1'
        labelColor = (side.vertexAttrs.labelColor.typeName === 'Double') ?
          labelColorMap[vertex.attrs[labelColorAttr].double] :
          labelColorMap[vertex.attrs[labelColorAttr].string];
      }

      let opacity = 1;
      if (opacityAttr) { opacity = vertex.attrs[opacityAttr].double / opacityMax; }

      let icon;
      if (side.vertexAttrs.icon) { icon = vertex.attrs[side.vertexAttrs.icon.id].string; }
      let image;
      if (side.vertexAttrs.image) { image = vertex.attrs[side.vertexAttrs.image.id].string; }

      const radius = 0.1 * Math.sqrt(size);
      const v = new Vertex(vertices,
                         vertex,
                         Math.random() - 0.5,
                         Math.random() - 0.5,
                         radius,
                         label,
                         labelSize,
                         color,
                         opacity,
                         labelColor,
                         icon,
                         image);
      offsetter.rule(v);
      v.id = vertex.id.toString();
      svg.addClass(v.dom, 'sampled');
      if (side.centers.indexOf(v.id) > -1) {
        svg.addClass(v.dom, 'center');
      }
      vertices.vs.push(v);

      this.sampledVertexMouseBindings(vertices, v, vertexGroup);
      vertexGroup.append(v.dom);
    }

    if (data.vertices.length >= 5) {
      vertices.addLegendLine(data.vertices.length + ' vertices');
    }
    return vertices;
  };

  function translateTouchToMouseEvent(ev) {
    if (ev.type === 'touchmove') {
      // Translate into mouse event.
      ev.pageX = ev.originalEvent.changedTouches[0].pageX;
      ev.pageY = ev.originalEvent.changedTouches[0].pageY;
      ev.preventDefault();
    }
  }

  GraphView.prototype.sampledVertexMouseBindings = function(vertices, vertex, vertexGroup) {
    const scope = this.scope;
    const svgElement = this.svg;
    const offsetter = vertex.offsetter;
    function modelX(pageX) {
      return (pageX - svgElement.offset().left - offsetter.xOff) / offsetter.zoom;
    }
    function modelY(pageY) {
      return (pageY - svgElement.offset().top - offsetter.yOff) / offsetter.zoom;
    }
    vertex.dom.on('mousedown touchstart', function(evStart) {
      evStart.stopPropagation();
      translateTouchToMouseEvent(evStart);
      vertex.hold();
      vertex.xDragStart = modelX(evStart.pageX);
      vertex.yDragStart = modelY(evStart.pageY);
      vertex.xBeforeDrag = vertex.x;
      vertex.yBeforeDrag = vertex.y;
      vertex.dragged = false;
      vertexGroup.append(vertex.dom);  // Bring to top.
      angular.element(window).on('mouseup touchend', function() {
        angular.element(window).off('mousemove mouseup touchmove touchend');
        if (!vertex.held) {
          return;  // Duplicate event.
        }
        vertex.release();
        if (vertex.dragged) {  // It was a drag.
          vertices.animate();
        } else {  // It was a click.
          scope.$apply(function() {
            const actions = [];
            const side = vertices.side;
            const id = vertex.id.toString();
            const attributes = {};
            // Iterate through the visualization modes (e.g. label, size) to get the list of
            // attributes which are visualized.
            for (let visMode in side.vertexAttrs) {
              const attribute = side.vertexAttrs[visMode];
              if (attribute !== undefined) {
                attributes[attribute.title] = vertex.data.attrs[attribute.id].string;
              }
            }

            if (!side.hasCenter(id)) {
              actions.push({
                title: 'Add to centers',
                callback: function() {
                  side.addCenter(id);
                },
              });
            }
            if (side.hasCenter(id)) {
              actions.push({
                title: 'Remove from centers',
                callback: function() {
                  side.removeCenter(id);
                },
              });
            }
            if (!side.hasCenter(id) || (side.centers.length !== 1)) {
              actions.push({
                title: 'Set as only center',
                callback: function() {
                  side.setCenter(id);
                },
              });
            }
            if (side.hasParent()) {
              if (side.isParentFilteredToSegment(id)) {
                actions.push({
                  title: 'Stop filtering base project to this segment',
                  callback: function() {
                    side.deleteParentsSegmentFilter();
                  },
                });
              } else {
                actions.push({
                  title: 'Filter base project to this segment',
                  callback: function() {
                    side.filterParentToSegment(id);
                  },
                });
              }
            }
            if (side.hasSegmentation()) {
              if (side.isSegmentationFilteredToParent(id)) {
                actions.push({
                  title: 'Stop filtering segmentation to this vertex',
                  callback: function() {
                    side.deleteSegmentationsParentFilter();
                  },
                });
              } else {
                actions.push({
                  title: 'Filter segmentation to this vertex',
                  callback: function() {
                    side.filterSegmentationToParent(id);
                  },
                });
              }
            }
            if (vertex.frozen) {
              actions.push({
                title: 'Unfreeze',
                callback: function() {
                  vertex.frozen -= 1;
                  vertices.animate();
                },
              });
            } else {
              actions.push({
                title: 'Freeze',
                callback: function() {
                  vertex.frozen += 1;
                },
              });
            }

            vertex.activateMenu({
              header: 'Vertex ' + id,
              type: 'vertex',
              id: id,
              actions: actions,
              attributes: attributes,
            });
          });
        }
      });
      angular.element(window).on('mousemove touchmove', function(ev) {
        if (vertex.positioned) { return; }
        translateTouchToMouseEvent(ev);
        const ex = modelX(ev.pageX);
        const ey = modelY(ev.pageY);
        vertex.dragged = ex !== vertex.xDragStart || ey !== vertex.yDragStart;
        const x = vertex.xBeforeDrag + ex - vertex.xDragStart;
        const y = vertex.yBeforeDrag + ey - vertex.yDragStart;
        vertex.moveTo(x, y);
        vertex.forceOX = x;
        vertex.forceOY = y;
        vertices.animate();
      });
    });
  };

  GraphView.prototype.bucketedVertexMouseBindings = function(vertices, vertex) {
    const scope = this.scope;
    vertex.dom.click(function() {
      scope.$apply(function() {
        const actions = [];
        const side = vertices.side;
        const xAttr = vertices.xAttribute;
        const yAttr = vertices.yAttribute;
        if (xAttr && vertex.xFilter) {
          actions.push({
            title: 'Add filter for ' + xAttr.title,
            callback: function() {
              side.setVertexFilter(xAttr.title, vertex.xFilter);
            },
          });
        }
        if (yAttr && vertex.yFilter) {
          actions.push({
            title: 'Add filter for ' + yAttr.title,
            callback: function() {
              side.setVertexFilter(yAttr.title, vertex.yFilter);
            },
          });
        }
        if (xAttr && yAttr && vertex.xFilter && vertex.yFilter) {
          actions.push({
            title: 'Add filter for ' + xAttr.title + ' & ' + yAttr.title,
            callback: function() {
              side.setVertexFilter(xAttr.title, vertex.xFilter);
              side.setVertexFilter(yAttr.title, vertex.yFilter);
            },
          });
        }
        if (actions.length > 0) {
          vertex.activateMenu({
            actions: actions,
          });
        }
      });
    });
  };

  GraphView.prototype.sideMouseBindings = function(offsetter, xMin, xMax) {
    const svgElement = this.svg;
    this.svgMouseDownListeners.push(function(evStart) {
      translateTouchToMouseEvent(evStart);
      const svgX = evStart.pageX - svgElement.offset().left;
      if ((svgX < xMin) || (svgX >= xMax)) {
        return;
      }
      const evXToXOff = offsetter.xOff - evStart.pageX;
      const evYToYOff = offsetter.yOff - evStart.pageY;
      angular.element(window).on('mousemove touchmove', function(evMoved) {
        translateTouchToMouseEvent(evMoved);
        offsetter.panTo(evMoved.pageX + evXToXOff, evMoved.pageY + evYToYOff);
      });
      angular.element(window).on('mouseup touchend', function() {
        angular.element(window).off('mousemove mouseup touchmove touchend');
      });
    });
    function zoom(position, deltaZoom, deltaThickness) {
      let delta = -0.001 * deltaZoom;
      // Graph-space point under the mouse should remain unchanged.
      // mxOff * zoom + xOff = position.x
      const mxOff = (position.x - offsetter.xOff) / offsetter.zoom;
      const myOff = (position.y - offsetter.yOff) / offsetter.zoom;
      offsetter.zoom *= Math.exp(delta);
      offsetter.xOff = position.x - mxOff * offsetter.zoom;
      offsetter.yOff = position.y - myOff * offsetter.zoom;
      // Shift-scroll, or horizontal scroll is applied only to thickness.
      delta += -0.005 * deltaThickness;
      // Thickness (vertex radius and edge width) changes by a square-root function.
      offsetter.thickness *= Math.exp(0.5 * delta);
      offsetter.reDraw();
    }
    this.svgMouseWheelListeners.push(function(e) {
      const oe = e.originalEvent;
      const mx = oe.pageX - svgElement.offset().left;
      const my = oe.pageY - svgElement.offset().top;
      if ((mx < xMin) || (mx >= xMax)) {
        return;
      }
      e.preventDefault();
      let deltaX = oe.deltaX;
      let deltaY = oe.deltaY;
      if (/Firefox/.test(window.navigator.userAgent)) {
        // Every browser sets different deltas for the same amount of scrolling.
        // It is tiny on Firefox. We need to boost it.
        deltaX *= 20;
        deltaY *= 20;
      }
      const plainScroll = oe.shiftKey ? 0 : deltaY;
      const shiftScroll = deltaX + (oe.shiftKey ? deltaY : 0);
      zoom({ x: mx, y: my }, plainScroll, shiftScroll);
    });
    this.svgDoubleClickListeners.push(function(e) {
      const oe = e.originalEvent;
      const mx = oe.pageX - svgElement.offset().left;
      const my = oe.pageY - svgElement.offset().top;
      if ((mx < xMin) || (mx >= xMax)) {
        return;
      }
      e.preventDefault();
      // Left/right is in/out.
      const scroll = e.which === 1 ? -500 : 500;
      // Shift affects thickness.
      const shift = oe.shiftKey;
      zoom(
        { x: mx, y: my },
        shift ? 0 : scroll,
        shift ? 0.5 * scroll : 0);
    });
  };

  GraphView.prototype.initSampled = function(vertices) {
    this.initLayout(vertices);
    this.initView(vertices, 10);
    this.initSlider(vertices);
  };

  // Returns the ideal zoom setting for the given coordinate bounds,
  // or undefined if one cannot be found.
  function zoomFor(xb, yb, width, height) {
    const xCenter = (xb.min + xb.max) / 2;
    const yCenter = (yb.min + yb.max) / 2;
    const xFit = 0.5 * width / (xb.max - xCenter);
    const yFit = 0.5 * height / (yb.max - yCenter);
    // Avoid infinite zoom for 1-vertex graphs.
    if (isFinite(xFit) || isFinite(yFit)) {
      // Take absolute value, just in case we have negative infinity.
      return graphToSVGRatio * Math.min(Math.abs(xFit), Math.abs(yFit));
    }
    return undefined;
  }

  // Returns the ideal panning coordinates. xb and yb are the coordinate bounds,
  // zoom is the offsetter zoom setting, width and height are the viewport dimensions,
  // and xMin is the viewport X offset.
  function panFor(xb, yb, zoom, width, height, xMin) {
    // The bounds of panning positions that can see the graph.
    const xOffMin = -xb.max * zoom + xMin;
    const xOffMax = -xb.min * zoom + xMin + width;
    const yOffMin = -yb.max * zoom;
    const yOffMax = -yb.min * zoom + height;
    return {
      // Returns true if the given offset is also acceptable.
      acceptable: function(xOff, yOff) {
        return xOffMin <= xOff && xOff <= xOffMax && yOffMin <= yOff && yOff <= yOffMax;
      },
      xOff: (xOffMin + xOffMax) / 2,
      yOff: (yOffMin + yOffMax) / 2,
    };
  }

  // Pan/zoom the view (the offsetter) to fit the graph, if necessary.
  GraphView.prototype.initView = function(vertices, tolerance) {
    const offsetter = vertices.offsetter;
    // Figure out zoom.
    const xb = common.minmax(vertices.vs.map(function(v) { return v.x; }));
    const yb = common.minmax(vertices.vs.map(function(v) { return v.y; }));
    const width = vertices.halfColumnWidth * 2;
    const height = this.svg.height();
    const newZoom = zoomFor(xb, yb, width, height) || offsetter.zoom;
    let newPan = panFor(xb, yb, offsetter.zoom, width, height, vertices.xMin);
    // Apply the calculated zoom if it is a new offsetter, or if the inherited zoom is way off.
    const ratio = newZoom / offsetter.zoom;
    if (!offsetter.inherited ||
        ratio < 1 / tolerance || ratio > tolerance ||
        !newPan.acceptable(offsetter.xOff, offsetter.yOff)) {
      offsetter.zoom = newZoom;
      offsetter.thickness = 1000 / Math.sqrt(vertices.vs.length);
      // Recalculate with the new zoom.
      newPan = panFor(xb, yb, newZoom, width, height, vertices.xMin);
      offsetter.xOff = newPan.xOff;
      offsetter.yOff = newPan.yOff;
    }
    offsetter.reDraw();
  };

  GraphView.prototype.initSlider = function(vertices) {
    this.unregistration.push(this.scope.$watch(sliderPos, onSlider));
    function sliderPos() {
      return vertices.side.sliderPos;
    }
    function onSlider() {
      const sliderAttr = vertices.side.vertexAttrs.slider;
      if (!sliderAttr) { return; }
      const sb = common.minmax(
          vertices.vs.map(function(v) { return (v.data.attrs[sliderAttr.id] || {}).double; }));
      const pos = sliderPos();
      for (let i = 0; i < vertices.vs.length; ++i) {
        const v = vertices.vs[i];
        const x =
          v.data.attrs[sliderAttr.id].defined ? v.data.attrs[sliderAttr.id].double : undefined;
        const norm = Math.floor(100 * common.normalize(x, sb) + 50);  // Normalize to 0 - 100.
        if (norm < pos) {
          v.color = 'hsl(120, 50%, 42%)';
        } else if (norm > pos) {
          v.color = 'hsl(0, 50%, 42%)';
        } else if (norm === pos) {
          v.color = 'hsl(60, 60%, 45%)';
        } else {
          v.color = 'hsl(60, 0%, 42%)';
        }
        v.icon.attr({ style: 'fill: ' + v.color });
      }
    }
  };

  function Clipper(bounds) {
    const rnd = Math.random().toString(36);
    const defs = svg.create('defs');
    const clip = svg.create('clipPath', { id: 'clip-' + rnd });
    const rect = svg.create('rect', bounds);
    clip.append(rect);
    defs.append(clip);
    this.dom = defs;
    this.url = 'url(#clip-' + rnd + ')';
  }

  function Map(gv, vertices) {
    this.gv = gv;
    this.vertices = vertices;
    this.group = svg.create('g', { 'class': 'map', 'clip-path': vertices.clipper.url });
    this.gv.root.prepend(this.group);
    // The size of the Earth in lat/long view. It doesn't make much difference,
    // just has to be a reasonable value to avoid too small/too large numbers.
    this.GLOBE_SIZE = 500;
    // Constant to match Google Maps projection.
    this.GM_MULT = 0.403;
    // How much to wait after pan/zoom events before requesting a new map.
    this.NAVIGATION_DELAY = 100;  // Milliseconds.
    this.root = 'https://maps.googleapis.com/maps/api/staticmap?';
    this.key = 'AIzaSyBcML5zQetjkRFuqpSSG6EmhS2vSWRssZ4';  // big-graph-gc1 API key.
    this.images = [];
    this.vertices.offsetter.rule(this);
    const that = this;
    const unwatch = util.deepWatch(this.gv.scope, 'mapFilters', function() { that.update(); });
    this.gv.unregistration.push(function() {
      unwatch();
    });
  }
  Map.prototype.lon2x = function(lon) {
    return this.GLOBE_SIZE * lon / 360;
  };
  Map.prototype.lat2y = function(lat) {
    return -this.GLOBE_SIZE * Math.log(
        Math.tan(lat * Math.PI / 180) +
        1 / Math.cos(lat * Math.PI / 180)
        ) / Math.PI / 2;
  };
  Map.prototype.x2lon = function(x) {
    return x * 360 / this.GLOBE_SIZE;
  };
  Map.prototype.y2lat = function(y) {
    return -Math.atan(Math.sinh(y * Math.PI * 2 / this.GLOBE_SIZE)) * 180 / Math.PI;
  };
  Map.prototype.reDraw = function() {
    const offsetter = this.offsetter;
    for (let i = 0; i < this.images.length; ++i) {
      const image = this.images[i];
      image.attr({
        x: image.x * offsetter.zoom + offsetter.xOff,
        y: image.y * offsetter.zoom + offsetter.yOff,
        width: offsetter.zoom * image.size,
        height: offsetter.zoom * image.size,
      });
    }
    if (this.lastZoom !== offsetter.zoom ||
        this.lastXOff !== offsetter.xOff ||
        this.lastYOff !== offsetter.yOff) {
      this.lastZoom = offsetter.zoom;
      this.lastXOff = offsetter.xOff;
      this.lastYOff = offsetter.yOff;
      $timeout.cancel(this.refresh);
      const that = this;
      this.refresh = $timeout(function() { that.update(); }, this.NAVIGATION_DELAY);
    }
  };
  Map.prototype.update = function() {
    const w = this.vertices.halfColumnWidth * 2;
    const h = this.gv.svg.height();
    const offsetter = this.offsetter;
    const x = (w / 2 - offsetter.xOff + this.vertices.xMin) / offsetter.zoom;
    const y = (h / 2 - offsetter.yOff) / offsetter.zoom;
    let zoomLevel = Math.log2(this.GLOBE_SIZE * offsetter.zoom / Math.max(w, h) / this.GM_MULT);
    zoomLevel = Math.max(0, Math.floor(zoomLevel));
    const clat = this.y2lat(y);
    const clon = this.x2lon(x);
    const image = svg.create('image');
    const filters = this.gv.scope.mapFilters;
    const style = 'feature:all' +
      // Map gamma to the [0.1, 10] range using an exponential scale.
      '|gamma:' + Math.pow(10, filters.gamma / 100) +
      '|saturation:' + filters.saturation +
      '|lightness:' + filters.brightness;
    const href = (
      this.root + 'center=' + clat + ',' + clon + '&zoom=' + zoomLevel +
      '&key=' + this.key +
      '&language=en' +
      '&size=640x640&scale=2&style=' + style);
    image[0].setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
    image.size = this.GLOBE_SIZE * Math.pow(2, -zoomLevel) / this.GM_MULT;
    image.x = x - image.size / 2;
    image.y = y - image.size / 2;
    // Disable drag & drop on Firefox.
    image.on('dragstart', function() { return false; });
    this.group.append(image);
    const images = this.images;
    images.push(image);
    // Discard old images, keeping the two most recent.
    for (let i = 0; i < images.length - 2; ++i) {
      images[i].remove();
    }
    images.splice(0, images.length - 2);
    this.reDraw();
  };

  GraphView.prototype.initLayout = function(vertices) {
    const positionAttr =
      (vertices.side.vertexAttrs.position) ? vertices.side.vertexAttrs.position.id : undefined;
    const geoAttr =
      (vertices.side.vertexAttrs.geo) ? vertices.side.vertexAttrs.geo.id : undefined;
    const map = geoAttr !== undefined ? new Map(this, vertices) : undefined;
    const edgesOf = {};
    if (vertices.edges !== undefined) {
      // Build edge lists for easy traversal.
      for (let j = 0; j < vertices.edges.length; ++j) {
        const e = vertices.edges[j];
        if (edgesOf[e.src.id] === undefined) { edgesOf[e.src.id] = []; }
        edgesOf[e.src.id].push(e.dst);
      }
    }
    for (let i = 0; i < vertices.vs.length; ++i) {
      const v = vertices.vs[i];
      v.degree = 0;
      if (positionAttr !== undefined && v.data.attrs[positionAttr].defined) {
        const pos = v.data.attrs[positionAttr];
        v.x = pos.x;
        v.y = -pos.y;  // Flip Y axis to look more mathematical.
        v.setPositioned();
      }
      if (geoAttr !== undefined && v.data.attrs[geoAttr].defined) {
        const pos = v.data.attrs[geoAttr];
        v.x = map.lon2x(pos.y);
        v.y = map.lat2y(pos.x);
        v.setPositioned();
      }
      v.forceOX = v.x;
      v.forceOY = v.y;
      // Identify separate components. If the component ID is unset, this is the first vertex
      // in the component. Spread its ID to all connected vertices.
      if (v.component === undefined && vertices.edges !== undefined) {
        const queue = [v];
        for (let j = 0; j < queue.length; ++j) {
          const w = queue[j];
          w.component = v.id;
          for (let k = 0; edgesOf[w.id] && k < edgesOf[w.id].length; ++k) {
            const u = edgesOf[w.id][k];
            if (queue.indexOf(u) === -1) {
              queue.push(u);
            }
          }
        }
      }
    }
    if (vertices.edges !== undefined) {
      for (let i = 0; i < vertices.edges.length; ++i) {
        const e = vertices.edges[i];
        e.src.degree += 1;
        e.dst.degree += 1;
      }
    }

    function getLayoutOpts() {
      const opts = {
        attraction: 0.1,
        repulsion: 1,
        gravity: 0,
        drag: 0.2,
        labelAttraction: vertices.side.animate.labelAttraction,
        style: vertices.side.animate.style,
        componentRepulsionFraction: 0.02,
        repulsionPower: 3,
      };
      if (['neutral', 'centralize', 'decentralize'].indexOf(opts.style) !== -1) {
        // Use the old layout for old style settings.
        opts.attraction = 0.01;
        opts.repulsion = 300;
        opts.gravity = 0.05;
        opts.repulsionPower = 2;
        opts.componentRepulsionFraction = 1;
      }
      return opts;
    }

    const engine = new FORCE_LAYOUT.Engine(getLayoutOpts());
    let lastLayoutStyle = engine.opts.style;
    engine.initForSeconds(vertices, 2);
    let animating = false;
    // Call vertices.animate() later to trigger interactive layout.
    vertices.animate = function() {
      if (!animating) {
        animating = true;
        window.requestAnimationFrame(vertices.step);
      }
    };
    const that = this;
    vertices.step = function() {
      const animate = vertices.side.animate;
      // This also ends up getting called when the side is closed due to the deep watch.
      // Accept this silently.
      if (!animate) { return; }
      engine.opts = getLayoutOpts();
      if (engine.opts.style !== lastLayoutStyle) {
        lastLayoutStyle = engine.opts.style;
        // Re-seed the layout. All styles assume the same initialization, but they don't generally
        // work well when started from each other's final states.
        for (let i = 0; i < vertices.vs.length; ++i) {
          const v = vertices.vs[i];
          v.x = Math.random() - 0.5;
          v.y = Math.random() - 0.5;
          v.forceOX = v.x;
          v.forceOY = v.y;
        }
        engine.initForSeconds(vertices, 2);
        that.initView(vertices, 1);
      }
      if (animating && animate.enabled && engine.step(vertices)) {
        window.requestAnimationFrame(vertices.step);
      } else {
        animating = false;
      }
    };
    vertices.animate();
    // Kick off animation when the user manually turns it on.
    const unwatch = util.deepWatch(this.scope,
        function() { return vertices.side.animate; },
        function() { vertices.animate(); });
    this.unregistration.push(function() {
      unwatch();
      animating = false;
    });
  };

  GraphView.prototype.addBucketedVertices = function(data, offsetter, viewData, vertexGroup) {
    const vertices = new Vertices(this);
    vertices.side = viewData;
    vertices.mode = 'bucketed';
    vertices.offsetter = offsetter;
    vertices.xAttribute = viewData.xAttribute;
    vertices.yAttribute = viewData.yAttribute;
    const xLabels = [], yLabels = [];
    const labelSpace = 0.05;
    const y = 0.5 + labelSpace;

    const xb = common.minmax(data.vertices.map(function(n) { return n.x; }));
    const yb = common.minmax(data.vertices.map(function(n) { return n.y; }));

    const xNumBuckets = xb.span + 1;
    const yNumBuckets = yb.span + 1;

    if (viewData.xAttribute) {
      // Label the X axis with the attribute name.
      const l = new Label(
          0, y - labelSpace, viewData.xAttribute.title,
          { classes: 'axis-label' });
      offsetter.rule(l);
      vertexGroup.append(l.dom);
    }
    for (let i = 0; i < data.xLabels.length; ++i) {
      const x = common.normalize(data.xLabelType === 'between' ? i : i + 0.5, xNumBuckets);
      const l = new Label(x, y, data.xLabels[i]);
      offsetter.rule(l);
      xLabels.push(l);
      vertexGroup.append(l.dom);
    }
    let x, side;
    // Labels on the left on the left and on the right on the right.
    if (offsetter.xOff < this.svg.width() / 2) {
      x = -0.5 - labelSpace;
      side = 'left';
    } else {
      x = 0.5 + labelSpace;
      side = 'right';
    }
    if (viewData.yAttribute) {
      // Label the Y axis with the attribute name.
      const mul = side === 'left' ? 1 : -1;
      const l = new Label(
          x + mul * labelSpace, 0, viewData.yAttribute.title,
          { vertical: true, classes: 'axis-label' });
      offsetter.rule(l);
      vertexGroup.append(l.dom);
    }
    for (let i = 0; i < data.yLabels.length; ++i) {
      const y = -common.normalize(data.yLabelType === 'between' ? i : i + 0.5, yNumBuckets);
      const l = new Label(x, y, data.yLabels[i], { classes: side });
      offsetter.rule(l);
      yLabels.push(l);
      vertexGroup.append(l.dom);
    }

    const sizes = data.vertices.map(function(n) { return n.size; });
    const vertexScale = 1 / common.minmax(sizes).max;
    for (let i = 0; i < data.vertices.length; ++i) {
      const vertex = data.vertices[i];
      const radius = 0.1 * Math.sqrt(vertexScale * vertex.size);
      const v = new Vertex(vertices,
                         vertex,
                         common.normalize(vertex.x + 0.5, xNumBuckets),
                         -common.normalize(vertex.y + 0.5, yNumBuckets),
                         radius,
                         vertex.size);
      offsetter.rule(v);
      vertices.vs.push(v);
      if (vertex.size === 0) {
        continue;
      }
      this.bucketedVertexMouseBindings(vertices, v);
      vertexGroup.append(v.dom);
      if (xLabels.length !== 0) {
        v.addHoverListener(xLabels[vertex.x]);
        if (data.xLabelType === 'between') { v.addHoverListener(xLabels[vertex.x + 1]); }
      }
      if (data.xFilters.length > 0) {
        v.xFilter = data.xFilters[vertex.x];
      }
      if (yLabels.length !== 0) {
        v.addHoverListener(yLabels[vertex.y]);
        if (data.yLabelType === 'between') { v.addHoverListener(yLabels[vertex.y + 1]); }
      }
      if (data.yFilters.length > 0) {
        v.yFilter = data.yFilters[vertex.y];
      }
    }
    return vertices;
  };

  GraphView.prototype.addEdges = function(edges, srcs, dsts, side, edgeGroup) {
    let widthKey;
    let colorKey;
    let colorMap;
    let labelKey;
    function attrKey(aggrAttr) {
      if (aggrAttr) {
        return aggrAttr.id + ':' + aggrAttr.aggregator;
      }
      return undefined;
    }
    if (side) {
      widthKey = attrKey(side.edgeAttrs.width);
      colorKey = attrKey(side.edgeAttrs.edgeColor);
      colorMap = srcs.setupColorMap(
        edges, side.edgeAttrs.edgeColor, 'Edge Color', colorKey);
      labelKey = attrKey(side.edgeAttrs.edgeLabel);
    }

    const edgeObjects = [];
    const edgeWidths = edges.map(function(e) {
      if (widthKey) {
        return (e.attrs[widthKey] || { double: 0.0 }).double;
      }
      return e.size;
    });
    const bounds = common.minmax(edgeWidths);
    const normalWidth = 0.02;
    const info = bounds.span / bounds.max;  // Information content of edge widths. (0 to 1)
    // Go up to 3x thicker lines if they are meaningful.
    const edgeScale = normalWidth * (1 + info * 2) / bounds.max;
    for (let i = 0; i < edges.length; ++i) {
      const edge = edges[i];
      const width = edgeWidths[i];
      if (edge.size === 0) {
        continue;
      }
      const a = srcs.vs[edge.a];
      const b = dsts.vs[edge.b];

      let color;
      if (colorKey && edge.attrs[colorKey].defined) {
        color = (side.edgeAttrs.edgeColor.typeName === 'Double') ?
          colorMap[edge.attrs[colorKey].double] : colorMap[edge.attrs[colorKey].string];
      }
      const label = labelKey ? edge.attrs[labelKey].string : undefined;
      const e = new Edge(a, b, edgeScale * width, color, label);
      edgeObjects.push(e);
      edgeGroup.append(e.dom);
    }
    return edgeObjects;
  };

  function Label(x, y, text, opts) {
    opts = opts || {};
    const classes = 'bucket ' + (opts.classes || '');
    this.x = x;
    this.y = y;
    this.vertical = opts.vertical;
    this.dom = svg.create('text', { 'class': classes }).text(text);
    if (this.vertical) {
      this.dom.attr({ transform: svgRotate(-90) });
    }
  }
  Label.prototype.on = function() { svg.addClass(this.dom, 'highlight'); };
  Label.prototype.off = function() { svg.removeClass(this.dom, 'highlight'); };
  Label.prototype.reDraw = function() {
    if (this.vertical) {
      this.dom.attr({x: -this.screenY(), y: this.screenX()});
    } else {
      this.dom.attr({x: this.screenX(), y: this.screenY()});
    }
  };

  function Vertex(
      vertices, data, x, y, r, text, textSize, color, opacity, labelColor, icon, image) {
    this.data = data;
    this.x = x;
    this.y = y;
    this.r = r;
    this.color = color || UNCOLORED;
    if (this.color === UNCOLORED) {
      this.highlight = 'white';
    } else {
      this.highlight = tinycolor(this.color).lighten(20).toString();
    }
    this.frozen = 0;  // Number of reasons why this vertex should not be animated.
    this.positioned = false;  // Is this vertex explicitly positioned?
    if (image) {
      this.icon = svg.create('image', { width: 1, height: 1 });
      this.icon[0].setAttributeNS('http://www.w3.org/1999/xlink', 'href', image);
      this.icon.center = { x: 0.5, y: 0.5 };
      this.icon.scale = 2.0;
    } else {
      this.icon = vertices.getIcon(icon);
      this.icon.attr({ style: 'fill: ' + this.color, 'class': 'icon' });
    }
    this.minTouchRadius = 10;
    if (r < this.minTouchRadius) {
      this.touch = svg.create('circle', { 'class': 'touch' });
    } else {
      this.touch = this.icon;
    }
    this.text = text;
    const fontSize = 30 * textSize;
    this.label = svg.create('text', { 'font-size': fontSize + 'px' }).text(text || '');
    if (labelColor !== undefined) {
      this.label.attr({ style: 'fill: ' + labelColor });
    }
    this.labelBackground = svg.create(
        'rect', {
          'class': 'label-background',
          width: 0, height: 0, rx: 2, ry: 2,
        });
    this.dom = svg.group(
        [this.icon, this.touch, this.labelBackground, this.label],
        {'class': 'vertex' });
    this.dom.attr({ opacity: opacity });
    this.moveListeners = [];
    this.highlightListeners = [];
    this.hoverListeners = [];
    // Notified when this vertex becomes opaque.
    this.opaqueListeners = [];
    this.isOpaque = false;
    const that = this;
    this.touch.mouseenter(function() {
      // Put the "fade-non-opaque" class on the whole SVG.
      svg.addClass(that.dom.closest('svg'), 'fade-non-opaque');
      if (!that.positioned) {
        that.setHighlight(true);
      }
      for (let i = 0; i < that.hoverListeners.length; ++i) {
        that.hoverListeners[i].on(that);
      }
    });
    this.touch.mouseleave(function() {
      // Remove the "fade-non-opaque" class from the whole SVG.
      svg.removeClass(that.dom.closest('svg'), 'fade-non-opaque');
      if (!that.held && !that.positioned) {
        that.setHighlight(false);
      }
      for (let i = 0; i < that.hoverListeners.length; ++i) {
        that.hoverListeners[i].off(that);
      }
    });
  }

  Vertex.prototype.setHighlight = function(on) {
    if (on) {
      svg.addClass(this.dom, 'highlight');
      this.icon.attr({style: 'fill: ' + this.highlight});
      for (let i = 0; i < this.highlightListeners.length; ++i) {
        this.highlightListeners[i].on(this);
      }
      // Size labelBackground here, because we may not know the label size earlier.
      this.labelBackground.attr({
        width: this.label[0].getBoundingClientRect().width + 4,
        height: this.label[0].getBoundingClientRect().height,
        style: 'fill: ' + this.highlight,
      });
      this.reDraw();
    } else {
      svg.removeClass(this.dom, 'highlight');
      this.icon.attr({style: 'fill: ' + this.color});
      for (let i = 0; i < this.highlightListeners.length; ++i) {
        this.highlightListeners[i].off(this);
      }
      this.labelBackground.attr({ style: '' });
    }
  };

  // Hover and highlight listeners must have an `on()` and an `off()` method.
  // "Hover" is used for the one vertex under the cursor.
  // "Highlight" is used for any vertices that we want to render more visible.
  Vertex.prototype.addHoverListener = function(hl) {
    this.hoverListeners.push(hl);
  };
  Vertex.prototype.addHighlightListener = function(hl) {
    this.highlightListeners.push(hl);
  };

  Vertex.prototype.addOpaqueListener = function(ol) {
    this.opaqueListeners.push(ol);
  };
  Vertex.prototype.setOpaque = function(on) {
    this.isOpaque = on;
    if (on) {
      svg.addClass(this.dom, 'opaque');
    } else {
      svg.removeClass(this.dom, 'opaque');
    }
    for (let i = 0; i < this.opaqueListeners.length; ++i) {
      this.opaqueListeners[i]();
    }
  };

  // Mark this vertex as explicitly positioned (as on a map).
  Vertex.prototype.setPositioned = function() {
    if (this.positioned) { return; }
    this.positioned = true;
    // Positioned vertices are highlighted to increase the contrast against the map,
    // and to distinguish them.
    this.setHighlight(true);
  };

  Vertex.prototype.addMoveListener = function(ml) {
    this.moveListeners.push(ml);
  };
  Vertex.prototype.moveTo = function(x, y) {
    this.x = x;
    this.y = y;
    this.reDraw();
  };
  Vertex.prototype.hold = function() {
    this.held = true;
  };
  Vertex.prototype.release = function() {
    this.held = false;
    this.touch.mouseleave();
  };
  function svgTranslate(x, y) { return ' translate(' + x + ' ' + y + ')'; }
  function svgScale(s) { return ' scale(' + s + ')'; }
  function svgRotate(deg) { return ' rotate(' + deg + ')'; }
  Vertex.prototype.reDraw = function() {
    const sx = this.screenX(), sy = this.screenY();
    const r = this.offsetter.thickness * this.r;
    this.icon[0].setAttribute('transform',
      svgTranslate(sx, sy) +
      svgScale(r * this.icon.scale) +
      svgTranslate(-this.icon.center.x, -this.icon.center.y));
    this.label[0].setAttribute('x', sx);
    this.label[0].setAttribute('y', sy);
    this.touch[0].setAttribute('cx', sx);
    this.touch[0].setAttribute('cy', sy);
    this.touch[0].setAttribute('r', r);

    const backgroundWidth = this.labelBackground[0].getAttribute('width');
    const backgroundHeight = this.labelBackground[0].getAttribute('height');
    this.labelBackground[0].setAttribute('x', sx - backgroundWidth / 2);
    this.labelBackground[0].setAttribute('y', sy - backgroundHeight / 2);
    for (let i = 0; i < this.moveListeners.length; ++i) {
      this.moveListeners[i](this);
    }
  };

  function Edge(src, dst, w, color, label) {
    this.src = src;
    this.dst = dst;
    this.w = w;
    this.first = svg.create('path', { 'class': 'first' });
    this.second = svg.create('path', { 'class': 'second' });
    if (color) {
      this.first.attr({ style: 'stroke: ' + color });
      this.second.attr({ style: 'stroke: ' + color });
    }
    const fontSize = 15;
    this.label = svg.create('text', { 'font-size': fontSize + 'px' }).text(label || '');
    this.dom = svg.group([this.second, this.first, this.label], {'class': 'edge'});
    const that = this;
    src.addMoveListener(function() { that.reposition(); });
    dst.addMoveListener(function() { that.reposition(); });
    this.reposition();
    // To highlight the neighborhood of a hovered/highlighted vertex, the
    // following rules are implemented below:
    //  - On either end's hover the edge sets both of its endpoints opaque.
    //  - On both ends becoming opaque the edge makes itself opaque.
    //  - On either end's highlight the edge highlights itself.
    function highlightListener(cls) {
      return {
        on: function() {
          svg.addClass(that.dom, cls);
          that.toFront();
        },
        off: function() {
          svg.removeClass(that.dom, cls);
        },
      };
    }
    const hoverListener = {
      on: function() {
        src.setOpaque(true);
        dst.setOpaque(true);
      },
      off: function() {
        src.setOpaque(false);
        dst.setOpaque(false);
      },
    };
    src.addHighlightListener(highlightListener('highlight-out'));
    src.addHoverListener(hoverListener);
    if (src !== dst) {
      dst.addHighlightListener(highlightListener('highlight-in'));
      dst.addHoverListener(hoverListener);
    }
    const opaqueListener = function() {
      if (src.isOpaque && dst.isOpaque) {
        svg.addClass(that.dom, 'opaque');
      } else {
        svg.removeClass(that.dom, 'opaque');
      }
    };
    src.addOpaqueListener(opaqueListener);
    dst.addOpaqueListener(opaqueListener);
  }
  Edge.prototype.setVisible = function(visible) {
    if (visible) {
      svg.removeClass(this.dom, 'invisible-edge');
    } else {
      svg.addClass(this.dom, 'invisible-edge');
    }
  };
  Edge.prototype.toFront = function() {
    this.dom.parent().append(this.dom);
  };
  Edge.prototype.reposition = function() {
    function isInside(vertex) {
      return vertex.screenX() >= vertex.offsetter.xMin &&
          vertex.screenX() <= vertex.offsetter.xMax;
    }
    const src = this.src, dst = this.dst;
    this.setVisible(
        src.offsetter.side === dst.offsetter.side || (isInside(src) && isInside(dst)));
    const avgZoom = 0.5 * (src.offsetter.thickness + dst.offsetter.thickness);
    const arrows = svg.arrows(src.screenX(), src.screenY(), dst.screenX(), dst.screenY(), avgZoom);
    this.first[0].setAttribute('d', arrows[0]);
    this.first[0].setAttribute('stroke-width', avgZoom * this.w);
    this.second[0].setAttribute('d', arrows[1]);
    this.second[0].setAttribute('stroke-width', avgZoom * this.w);
    const arcParams = svg.arcParams(
      src.screenX(), src.screenY(), dst.screenX(), dst.screenY(), avgZoom);
    this.label[0].setAttribute('x', arcParams.x);
    this.label[0].setAttribute('y', arcParams.y);
  };

  return directive;
});
