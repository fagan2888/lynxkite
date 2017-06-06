// The links at the bottom of every page, such as "logout".
'use strict';

angular.module('biggraph').directive('userMenu', function($window, util) {
  return {
    restrict: 'E',
    scope: {
      info: '=',  // Debug data to post with "send feedback".
      direction: '@',  // Class selector for the dropup menu: "dropup" or "dropdown".
    },
    templateUrl: 'scripts/util/user-menu.html',
    link: function(scope) {
      scope.util = util;

      scope.sendFeedback = function() {
        util.reportError({
          message: 'Click "report" to send an email about this page.',
          details: scope.info });
      };

      scope.logout = function() {
        util.post('/logout', {}).then(function() {
          $window.location.href = '/';
        });
      };
    },
  };
});