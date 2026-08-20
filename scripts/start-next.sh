#!/bin/bash
cd /home/z/my-project
exec npx next dev > /tmp/next.log 2>&1
