/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { find, template } from 'lodash';
import { stringify } from 'query-string';
import $ from 'jquery';
import rison from 'rison-node';
import '../../doc_viewer';

import openRowHtml from './table_row/open.html';
import detailsHtml from './table_row/details.html';

import { dispatchRenderComplete, url } from '../../../../../../../../../src/plugins/opensearch_dashboards_utils/public';
import { DOC_HIDE_TIME_COLUMN_SETTING } from '../../../../common';
import cellTemplateHtml from '../components/table_row/cell.html';
import truncateByHeightTemplateHtml from '../components/table_row/truncate_by_height.html';
import { opensearchFilters } from '../../../../../../../../../src/plugins/data/public';
import { getServices } from '../../../../kibana_services';

const TAGS_WITH_WS = />\s+</g;

/**
 * Remove all of the whitespace between html tags
 * so that inline elements don't have extra spaces.
 */
export function noWhiteSpace(html: string): string {
  return html.replace(TAGS_WITH_WS, '><');
}

// guesstimate at the minimum number of chars wide cells in the table should be
const MIN_LINE_LENGTH = 20;

interface LazyScope extends ng.IScope {
  [key: string]: any;
}

export function createTableRowDirective($compile: ng.ICompileService) {
  const cellTemplate = template(noWhiteSpace(cellTemplateHtml));
  const truncateByHeightTemplate = template(noWhiteSpace(truncateByHeightTemplateHtml));

  return {
    restrict: 'A',
    scope: {
      columns: '=',
      filter: '=',
      indexPattern: '=',
      row: '=kbnTableRow',
      onAddColumn: '=?',
      onRemoveColumn: '=?',
    },
    link: ($scope: LazyScope, $el: JQuery) => {
      $el.after('<tr data-test-subj="docTableDetailsRow" class="kbnDocTableDetails__row">');
      $el.empty();

      // when we compile the details, we use this $scope
      let $detailsScope: LazyScope;

      // when we compile the toggle button in the summary, we use this $scope
      let $toggleScope;

      // toggle display of the rows details, a full list of the fields from each row
      $scope.toggleRow = () => {
        const $detailsTr = $el.next();

        $scope.open = !$scope.open;

        ///
        // add/remove $details children
        ///

        $detailsTr.toggle($scope.open);

        if (!$scope.open) {
          // close the child scope if it exists
          $detailsScope.$destroy();
          // no need to go any further
          return;
        } else {
          $detailsScope = $scope.$new();
        }

        // empty the details and rebuild it
        $detailsTr.html(detailsHtml);
        $detailsScope.row = $scope.row;
        $detailsScope.hit = $scope.row;
        $detailsScope.uriEncodedId = encodeURIComponent($detailsScope.hit._id);

        $compile($detailsTr)($detailsScope);
      };

      $scope.$watchMulti(['indexPattern.timeFieldName', 'row.highlight', '[]columns'], () => {
        createSummaryRow($scope.row);
      });

      $scope.inlineFilter = function inlineFilter($event: any, type: string) {
        const column = $($event.currentTarget).data().column;
        const field = $scope.indexPattern.fields.getByName(column);
        $scope.filter(field, $scope.flattenedRow[column], type);
      };

      $scope.getContextAppHref = () => {
        return `${getDiscoverPath()}#/context/${encodeURIComponent($scope.indexPattern.id)}/${ encodeURIComponent($scope.row._id) }?_a=(columns:!(_source),filters:!())`
      };

      $scope.getDocLink = (id) => {
        return `${getDiscoverPath()}#/doc/${$scope.indexPattern.id}/${$scope.row._index}?id=${id}`
      };

      function getDiscoverPath(){
        const pathName = `${location.pathname}#`;
        return `${location.origin}${pathName.replace(/\/app\/(.*)/, '/app/discover')}`;
      }

      // create a tr element that lists the value for each *column*
      function createSummaryRow(row: any) {
        const indexPattern = $scope.indexPattern;
        $scope.flattenedRow = indexPattern.flattenHit(row);

        // We just create a string here because its faster.
        const newHtmls = [openRowHtml];

        const mapping = indexPattern.fields.getByName;
        const hideTimeColumn = getServices().uiSettings.get(DOC_HIDE_TIME_COLUMN_SETTING, false);
        if (indexPattern.timeFieldName && !hideTimeColumn) {
          newHtmls.push(
            cellTemplate({
              timefield: true,
              formatted: _displayField(row, indexPattern.timeFieldName),
              filterable: mapping(indexPattern.timeFieldName).filterable && $scope.filter,
              column: indexPattern.timeFieldName,
            })
          );
        }

        $scope.columns.forEach(function (column: any) {
          const isFilterable = mapping(column) && mapping(column).filterable && $scope.filter;

          newHtmls.push(
            cellTemplate({
              timefield: false,
              sourcefield: column === '_source',
              formatted: _displayField(row, column, true),
              filterable: isFilterable,
              column,
            })
          );
        });

        let $cells = $el.children();
        newHtmls.forEach(function (html, i) {
          const $cell = $cells.eq(i);
          if ($cell.data('discover:html') === html) return;

          const reuse = find($cells.slice(i + 1), function (cell: any) {
            return $.data(cell, 'discover:html') === html;
          });

          const $target = reuse ? $(reuse).detach() : $(html);
          $target.data('discover:html', html);
          const $before = $cells.eq(i - 1);
          if ($before.length) {
            $before.after($target);
          } else {
            $el.append($target);
          }

          // rebuild cells since we modified the children
          $cells = $el.children();

          if (!reuse) {
            $toggleScope = $scope.$new();
            $compile($target)($toggleScope);
          }
        });

        if ($scope.open) {
          $detailsScope.row = row;
        }

        // trim off cells that were not used rest of the cells
        $cells.filter(':gt(' + (newHtmls.length - 1) + ')').remove();
        dispatchRenderComplete($el[0]);
      }

      /**
       * Fill an element with the value of a field
       */
      function _displayField(row: any, fieldName: string, truncate = false) {
        const indexPattern = $scope.indexPattern;
        const text = indexPattern.formatField(row, fieldName);

        if (truncate && text.length > MIN_LINE_LENGTH) {
          return truncateByHeightTemplate({
            body: text,
          });
        }

        return text;
      }
    },
  };
}
