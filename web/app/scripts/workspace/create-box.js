'use strict';

// Creates a box object for a workspace.
// This object wraps the actual box data representation and
// provides methods to interact with the GUI, e.g. mouse events
// and values to bind with Angular to SVG elements.
// The wrapped box date representation has two parts:
// - metadata describes the type of operation of the box.
// - instance describes the operation parameter values,
//   coordinates on the workspace and everything related to this
//   box instance that have to be saved.

angular.module('biggraph').factory('createBox', function() {
  return function(metadata, instance) {
    var width = 200;
    var height = 40;

    // An input or output connection point of a box.
    function createPlug(plug, index, direction) {
      var plugRadius = 8;

      var len = metadata[direction].length;
      var x;
      if (len <= 1) {
        x = width / 2;
      } else {
        var r = plugRadius;
        x = (width - r) / len * index + r;
      }
      var y = direction === 'outputs' ? height + 15 : -15;

      function progressToColor(progressRatio) {
        /* global tinycolor */
        return tinycolor.mix('blue', 'green', progressRatio * 100).toHexString();
      }

      return {
        boxId: instance.id,
        instance: instance,
        data: plug,
        index: index,
        direction: direction,
        radius: plugRadius,
        x: function() { return x + instance.x; },
        y: function() { return y + instance.y; },
        posTransform: 'translate(' + x + ', ' + y + ')',
        inProgress: false,
        progressColor: undefined,
        error: '',
        updateStatus: function(status) {
          var progress = status.progress;
          var all = 0;
          for (var p in progress) {
            if (progress.hasOwnProperty(p)) {
              all += progress[p];
            }
          }
          if (all) {
            var progressPercentage = progress.computed / all;
            this.progressColor = progressToColor(progressPercentage);
            this.inProgress = progress.inProgress > 0;
          } else {
            this.clearProgress();
          }

          if (status.success.enabled) {
            this.error = '';
          } else {
            this.error = status.success.disabledReason;
          }
        },

        clearProgress: function() {
          this.inProgress = false;
          this.progressColor = undefined;
        },

        clearStatus: function() {
          this.clearProgress();
          this.error = '';
        }
      };
    }

    var inputs = [];
    var outputs = [];
    var outputMap = {};
    var i;
    for (i = 0; i < metadata.inputs.length; ++i) {
      inputs.push(createPlug(metadata.inputs[i], i, 'inputs'));
    }
    for (i = 0; i < metadata.outputs.length; ++i) {
      var plug = createPlug(metadata.outputs[i], i, 'outputs');
      outputs.push(plug);
      outputMap[plug.data.id] = plug;
    }
    return {
      metadata: metadata,
      instance: instance,
      inputs: inputs,
      outputs: outputs,
      outputMap: outputMap,
      width: width,
      height: height,
      isMoved: false,
      mainPosTransform: function() {
        return 'translate(' + this.instance.x + ', ' + this.instance.y + ')';
      },
      onMouseMove: function(mousePos) {
        this.isMoved = true;
        this.instance.x = mousePos.x + this.xOffset;
        this.instance.y = mousePos.y + this.yOffset;
      },
      onMouseDown: function(mousePos) {
        this.xOffset = this.instance.x - mousePos.x;
        this.yOffset = this.instance.y - mousePos.y;
      },
    };
  };
});
