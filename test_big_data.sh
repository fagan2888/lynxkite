#!/bin/bash -xue

# This is the script that Jenkins calls when the user wants to run a "big data"
# test on a Pull Request. It fires up an EMR cluster, runs groovy scripts in it
# and creates a file with the results. In case of Jenkins, it also dumps the test
# results as a commit into the PR.
#
# Usage: test_big_data.sh test_pattern test_data_set [number of emr instances]
# Usage examples:
#   test_big_data.sh '*' fake_westeros_xt_25m
#   test_big_data.sh pagerank fake_westeros_xt_25m
#   test_big_data.sh centrality twitter 10
#
# The test codes are located in the git repo under: kitescripts/big_data_tests
# The test data files are located under: s3://lynxkite-test-data/
# To generate your own test data files, see:
# kitescripts/gen_test_data/generate_fake_westeros.groovy

cd $(dirname $0)

TEST_PATTERN="${1:-*}"
DATA_SET="${2:-fake_westeros_xt_25m}"
NUM_EMR_INSTANCES=${3:-3}

OUTPUT_FILE="last_results_${NUM_EMR_INSTANCES}i_${DATA_SET}"

# Run test.
NUM_INSTANCES=${NUM_EMR_INSTANCES} \
  tools/emr_based_test.sh backend "big_data_tests/${TEST_PATTERN}" testDataSet:${DATA_SET} 2>&1 \
  | tee kitescripts/big_data_tests/full_output

# Write the header.
cat >kitescripts/big_data_tests/${OUTPUT_FILE}.md.new <<EOF
LynxKite big data test results
==============================

This file is generated by [test_big_data.sh](https://github.com/biggraph/biggraph/blob/master/test_big_data.sh).

To update this file, run \`test_big_data.sh '${TEST_PATTERN}' '${DATA_SET}' ${NUM_EMR_INSTANCES}\`.

You can also simply comment _"Big Data Test please"_ on any pull request. That will trigger
running the big data tests with the default parameters of \`test_big_data.sh\`. Once that's done,
a change for the corresponding \`last_results_...\` file will be pushed to the pull request by
Jenkins.

The results of the latest run are below:
\`\`\`
EOF
# Add the script output from the new run.
cat kitescripts/big_data_tests/full_output \
  | awk '/STARTING SCRIPT/{flag=1}/FINISHED SCRIPT/{print;flag=0}flag' \
  >> kitescripts/big_data_tests/${OUTPUT_FILE}.md.new
echo '```' >>kitescripts/big_data_tests/${OUTPUT_FILE}.md.new
rm kitescripts/big_data_tests/full_output

if [[ "$USER" == 'jenkins' ]]; then
  # Commit and push changed output on PR branch.
  git config user.name 'lynx-jenkins'
  git config user.email 'pizza-support@lynxanalytics.com'
  git config push.default simple
  export GIT_SSH_COMMAND='ssh -i ~/.ssh/lynx-jenkins'
  git fetch
  git checkout "$GIT_BRANCH"
  git reset --hard "origin/$GIT_BRANCH"  # Discard potential local changes from failed runs.
  mv kitescripts/big_data_tests/${OUTPUT_FILE}.md{.new,}
  git add kitescripts/big_data_tests/${OUTPUT_FILE}.md
  git commit -am "Update Big Data Test results."
  git push
fi