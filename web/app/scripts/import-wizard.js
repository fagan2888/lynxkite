// UI for importing external data.
'use strict';

angular.module('biggraph').directive('importWizard', function(util) {
  return {
    scope: { expanded: '=', tableImported: '=', currentDirectory: '=' },
    templateUrl: 'import-wizard.html',
    link: function(scope) {
      scope.csv = {
        delimiter: ',',
        mode: 'FAILFAST',
      };
      scope.cancel = function(event) {
        scope.expanded = false;
        event.stopPropagation();
      };
      scope.importCSV = function() {
        scope.inputsDisabled = true;
        scope.importInProgress = true;
        util.post(
          '/ajax/importCSV',
          {
            files: scope.csv.filename,
            columnNames: scope.csv.columnNames ? scope.csv.columnNames.split(',') : [],
            delimiter: scope.csv.delimiter,
            mode: scope.csv.mode,
          }).catch(function() {
            scope.inputsDisabled = false;
          }).finally(function() {
            scope.importInProgress = false;
          }).then(function(importResult) {
            scope.checkpoint = importResult.checkpoint;
          });
      };
      scope.saveTable = function(event) {
        event.stopPropagation();
        scope.savingTable = true;
        var tableName = scope.tableName;
        if (scope.currentDirectory) {
          tableName = scope.currentDirectory + '/' + tableName;
        }
        util.post(
          '/ajax/saveTable',
          {
            'tableName': tableName,
            'checkpoint': scope.checkpoint,
            'privacy': 'public-read',
          }).then(function(result) {
            scope.tableImported = result;
          }).finally(function() {
            scope.savingTable = false;
          });
      };
    },
  };
});
