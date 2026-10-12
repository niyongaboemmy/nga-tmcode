$(function () {
  function update() {
    const n = $("#list li").length;
    $("#count").text(n + (n === 1 ? " task" : " tasks"));
  }

  $("#add").on("submit", function (e) {
    e.preventDefault();
    const text = $("#task").val().trim();
    if (!text) return;
    $("<li>")
      .text(text)
      .append($("<button>").addClass("remove").text("×"))
      .hide()
      .appendTo("#list")
      .fadeIn(200);
    $("#task").val("").focus();
    update();
  });

  // Delegated event: works for items added later.
  $("#list").on("click", ".remove", function () {
    $(this).parent().fadeOut(200, function () {
      $(this).remove();
      update();
    });
  });

  $("#list").on("click", "li", function () {
    $(this).toggleClass("done");
  });

  update();
  console.log("jQuery", $.fn.jquery, "is ready");
});
