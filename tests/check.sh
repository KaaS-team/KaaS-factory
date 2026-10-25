source node_modules/dep.sh && dep_ok || { echo "dependency missing"; exit 3; }
source src/boot.sh
[ "$ready" = 1 ] || { echo "boot error"; exit 2; }
echo run >> node_modules/written.txt
echo "secret=${FAKE_SECRET:-unset}"
source src/guard.sh
if guard evil; then echo "1 failed"; exit 1; fi
echo "0 failed"
