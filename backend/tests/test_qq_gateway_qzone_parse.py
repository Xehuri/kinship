from __future__ import annotations

import pytest

from services.qq_gateway.qzone_parse import (
    djb2_gtk,
    extract_response_code,
    extract_response_result,
    normalize_comment,
    normalize_comments,
    normalize_feed,
    normalize_feeds,
    normalize_uin,
    parse_cookie_string,
    parse_jsonp,
)


def test_parse_jsonp_accepts_preload_wrapper_with_brace_in_string() -> None:
    payload = parse_jsonp('_preloadCallback({"code":0,"msg":"a}b"});')

    assert payload == {"code": 0, "msg": "a}b"}


def test_parse_jsonp_accepts_raw_json() -> None:
    payload = parse_jsonp('{"code": 7, "data": {"x": 1}}')

    assert payload["code"] == 7
    assert payload["data"] == {"x": 1}


def test_parse_jsonp_accepts_callback_and_trailing_whitespace() -> None:
    payload = parse_jsonp('_Callback({"code":1});\n   ')

    assert payload["code"] == 1


def test_parse_jsonp_rejects_invalid_input() -> None:
    with pytest.raises(ValueError):
        parse_jsonp("_Callback({not-json});")


def test_parse_cookie_string_keeps_equals_inside_values() -> None:
    cookies = parse_cookie_string(
        "uin=o010001; skey=AbC=123==; p_skey=; flag;  empty=;  "
    )

    assert cookies["uin"] == "o010001"
    assert cookies["skey"] == "AbC=123=="
    assert cookies["p_skey"] == ""
    assert "flag" not in cookies


def test_gtk_vectors() -> None:
    assert djb2_gtk("abc") == "193485963"
    assert djb2_gtk("0123456789abcdef") == "1426588295"


def test_normalize_uin_strips_leading_o_and_zero() -> None:
    assert normalize_uin("o010001") == "10001"
    assert normalize_uin("") == ""


def test_normalize_comment_maps_fields() -> None:
    comment = normalize_comment({
        "tid": 123,
        "uin": 456,
        "nickname": "Alice",
        "content": "hi",
        "createTime": 1700000001,
        "list_3": [{"tid": 999}],
    })

    assert comment == {
        "comment_id": "123",
        "uin": "456",
        "nick": "Alice",
        "content": "hi",
        "created_time": 1700000001,
        "created_at": "2023-11-15T06:13:21+08:00",
        "parent_id": None,
        "replies": [],
    }


def test_normalize_comment_prefers_name_field() -> None:
    comment = normalize_comment({"tid": "c1", "uin": "456", "name": "Alice", "content": "hi"})

    assert comment["nick"] == "Alice"


def test_normalize_comment_falls_back_to_nickname_then_nick() -> None:
    assert normalize_comment({"nickname": "Bob"})["nick"] == "Bob"
    assert normalize_comment({"nick": "Carol"})["nick"] == "Carol"
    assert normalize_comment({"name": "", "nickname": "Bob"})["nick"] == "Bob"


def test_normalize_feed_full_entry() -> None:
    feed = normalize_feed({
        "tid": "feed-1",
        "createTime": 1700000000,
        "content": "hello",
        "uin": 10001,
        "cmtnum": "2",
        "has_more_con": 0,
        "pic": [
            {
                "url1": "https://img.example/a.jpg",
                "url2": "https://img.example/a-large.jpg",
                "pic_id": "pic-a",
            },
            {"url1": "https://img.example/a.jpg"},
            {"pic_id": "pic-b"},
        ],
        "video": [{"url3": "https://video.example/v.mp4"}],
        "rt_con": {"content": "reposted text"},
        "commentlist": [
            {
                "tid": "c1",
                "uin": 20001,
                "nickname": "Alice",
                "content": "main comment",
                "createTime": "1700000001",
                "list_3": [
                    {
                        "tid": "r1",
                        "uin": 20002,
                        "nickname": "Bob",
                        "content": "reply one",
                        "createTime": 1700000002,
                    }
                ],
            }
        ],
    })

    assert feed["tid"] == "feed-1"
    assert feed["uin"] == "10001"
    assert feed["created_time"] == 1700000000
    assert feed["created_at"] == "2023-11-15T06:13:20+08:00"
    assert feed["content"] == "hello"
    assert feed["images"] == ["https://img.example/a.jpg", "pic-b"]
    assert feed["videos"] == ["https://video.example/v.mp4"]
    assert feed["repost"] == "reposted text"
    assert feed["comment_count"] == 2
    assert feed["has_more_comments"] is False
    assert len(feed["comments"]) == 2
    parent, reply = feed["comments"]
    assert parent["comment_id"] == "c1"
    assert parent["parent_id"] is None
    assert parent["created_at"] == "2023-11-15T06:13:21+08:00"
    assert reply["comment_id"] == "r1"
    assert reply["parent_id"] == "c1"
    assert reply["created_at"] == "2023-11-15T06:13:22+08:00"
    assert [item["comment_id"] for item in parent["replies"]] == ["r1"]
    assert parent["replies"][0] is reply


def test_normalize_comments_orders_main_before_replies() -> None:
    comments = normalize_comments({
        "commentlist": [
            {"tid": "c1", "content": "one", "list_3": [{"tid": "r1"}, {"tid": "r2"}]},
            {"tid": "c2", "content": "two", "list_3": [{"tid": "r3"}]},
        ]
    })

    assert [item["comment_id"] for item in comments] == ["c1", "r1", "r2", "c2", "r3"]
    assert [item["parent_id"] for item in comments] == [None, "c1", "c1", None, "c2"]


def test_normalize_feeds_handles_missing_msglist() -> None:
    assert normalize_feeds({}) == []
    assert normalize_feeds({"msglist": []}) == []
    assert normalize_feeds({"msglist": "nope"}) == []


def test_normalize_feeds_skips_malformed_entries() -> None:
    feeds = normalize_feeds({
        "msglist": [
            "bad",
            5,
            {"content": ""},
            {"tid": "ok", "content": "kept"},
        ]
    })

    assert [feed["tid"] for feed in feeds] == ["ok"]


def test_normalize_feeds_respects_limit() -> None:
    feeds = normalize_feeds(
        {"msglist": [{"tid": "a", "content": "a"}, {"tid": "b", "content": "b"}]},
        limit=1,
    )

    assert [feed["tid"] for feed in feeds] == ["a"]


def test_extract_response_result_reads_code_subcode_and_message() -> None:
    text = 'frameElement.callback({"code":0,"subcode":-12,"message":"fail"});'

    assert extract_response_result(text) == (0, -12, "fail")


def test_extract_response_result_accepts_jsonp_and_msg_alias() -> None:
    assert extract_response_result('_Callback({"code":0,"subcode":"0","msg":"ok"});') == (0, 0, "ok")


def test_extract_response_result_returns_empty_values_for_malformed_payload() -> None:
    assert extract_response_result("not a payload") == (None, None, "")


def test_extract_response_result_tolerates_unquoted_keys() -> None:
    text = 'frameElement.callback({code:0,subcode:0,message:""});'

    assert extract_response_result(text) == (0, 0, "")


def test_extract_response_result_tolerates_single_quotes() -> None:
    assert extract_response_result("{'code':0,'subcode':0,'message':'ok'}") == (0, 0, "ok")


def test_extract_response_result_treats_undefined_subcode_as_none() -> None:
    assert extract_response_result("{code:0,subcode:undefined}") == (0, None, "")


def test_extract_response_result_does_not_invent_code_when_absent() -> None:
    assert extract_response_result("<html><body>busy</body></html>") == (None, None, "")


def test_extract_response_code_from_frame_callback_with_brace_in_string() -> None:
    text = 'frameElement.callback({"code":0,"msg":"a}b"});'

    assert extract_response_code(text) == 0


def test_extract_response_code_returns_none_for_malformed_payload() -> None:
    assert extract_response_code('frameElement.callback({"code":0') is None
    assert extract_response_code("not a payload") is None


def test_extract_response_code_accepts_json_and_numeric_string() -> None:
    assert extract_response_code('{"code": 12}') == 12
    assert extract_response_code('_Callback({"code": "3"});') == 3
